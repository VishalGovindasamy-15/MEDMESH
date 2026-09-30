"""MedMesh API.

Run:  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

Layering, matching §9.1 of the architecture report:

    routers/     presentation-facing HTTP + WebSocket surface
    services/    trust engine, matching engine, geo, audit
    live.py      in-memory capacity projection and pub/sub fan-out
    models.py    operational schema (no patient data by construction)
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import select

from .config import settings
from .database import Base, SessionLocal, engine
from .live import live_store
from .models import Hospital, IntegrationMode, utcnow
from .routers import (
    analytics,
    auth,
    connectors,
    dispatch,
    doctors,
    governance,
    hospitals,
    passwords,
    ws,
)
from .services.connectors import ConnectorError
from .seed import seed_all

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("medmesh")


def _bootstrap() -> dict:
    """Create schema, seed if empty, warm the live projection."""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        result = seed_all(db)
        if result.get("seeded"):
            log.info("seeded pilot dataset: %s", result)
        else:
            log.info("existing dataset found — %s", result.get("reason"))
        return result
    finally:
        db.close()


def _warm_projection() -> int:
    """Rebuild the in-memory capacity store from the durable series on boot.

    Without this, a restarted process serves an empty map until the first
    hospital happens to push an update -- which, for a manual facility, could be
    hours. The projection is a cache; it must be reconstructible.
    """
    from .repository import latest_capacity_map

    db = SessionLocal()
    try:
        hospitals = list(db.execute(select(Hospital)).scalars().all())
        latest = latest_capacity_map(db, [h.id for h in hospitals])
        for h in hospitals:
            row = latest.get(h.id)
            if row is None:
                continue
            from .live import CapacityView

            live_store.put(
                CapacityView(
                    hospital_id=h.id,
                    beds_available=row.beds_available,
                    total_beds=h.total_beds,
                    icu_available=row.icu_available,
                    total_icu=h.total_icu,
                    ventilators_available=row.ventilators_available,
                    total_ventilators=h.total_ventilators,
                    ed_congestion=row.ed_congestion.value,
                    ed_waiting=row.ed_waiting,
                    blood_units=row.blood_units,
                    antivenom_vials=row.antivenom_vials,
                    source=row.source.value,
                    recorded_at=row.recorded_at,
                    trust_state="live",
                )
            )
        log.info("live projection warmed with %d facilities", len(list(live_store.all())))
        return len(list(live_store.all()))
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Hand the running loop to the socket layer before anything can write. The
    # capacity ingest path is synchronous and reaches the websocket fan-out
    # through `live_store.publish_soon`, which needs a loop to schedule onto;
    # without this the write paths silently publish to nobody.
    live_store.bind_loop(asyncio.get_running_loop())

    _bootstrap()
    _warm_projection()

    from .simulator import start_background_loops

    tasks = await start_background_loops()
    app.state.background_tasks = tasks
    log.info("MedMesh API ready — %d facilities, %d subscribers", len(list(live_store.all())), live_store.subscriber_count)
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        live_store.bind_loop(None)
        log.info("MedMesh API shutting down")


app = FastAPI(
    title="MedMesh API",
    version="1.0.0",
    description=(
        "Real-time healthcare capacity exchange. Aggregates bed, ICU, ventilator, "
        "ED and specialist availability from hospital systems and manual dashboards, "
        "and exposes it to emergency dispatch, citizens, hospitals and government. "
        "Handles aggregate operational data only — no patient-identifiable records exist in this schema."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # Without this the CSV exports lose their filename in the browser:
    # `Content-Disposition` is not a CORS-safelisted response header, so a
    # cross-origin fetch cannot read it and every download falls back to a
    # generic name. The server has always sent a good one.
    expose_headers=["Content-Disposition", "Content-Length"],
)
app.add_middleware(GZipMiddleware, minimum_size=800)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(self), microphone=(), camera=()"
    return response


app.include_router(auth.router, prefix="/api/v1")
app.include_router(passwords.router, prefix="/api/v1")
app.include_router(hospitals.router, prefix="/api/v1")
app.include_router(doctors.router, prefix="/api/v1")
app.include_router(dispatch.router, prefix="/api/v1")
app.include_router(analytics.router, prefix="/api/v1")
app.include_router(governance.router, prefix="/api/v1")
app.include_router(connectors.router, prefix="/api/v1")
app.include_router(connectors.onboarding_router, prefix="/api/v1")
app.include_router(ws.router)

# Machine ingress for third-party hospital systems. Mounted outside /api/v1
# because it is a separate contract with its own audience and versioning: a
# partner's integration should not break because the console's API moved.
app.include_router(connectors.ingest_router)


@app.get("/api/v1/status")
def status() -> dict:
    """Unauthenticated liveness probe for the load balancer and the status strip."""
    return {
        "service": "medmesh-api",
        "version": "1.0.0",
        "environment": settings.environment,
        "time": utcnow().isoformat() + "Z",
        "projection": {"facilities": len(list(live_store.all())), "subscribers": live_store.subscriber_count},
        "simulator": settings.simulator_enabled,
    }


@app.exception_handler(ConnectorError)
async def _connector_error(_request: Request, exc: ConnectorError) -> JSONResponse:
    """A partner system's integration bug is not a server fault.

    An unknown or revoked key is a 401 with a machine-readable body, not a 500
    plus a stack trace in the partner's logs, and not a redirect to a login page
    that their client cannot fill in.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "error": "connector_rejected"},
    )


@app.exception_handler(500)
async def unhandled(request: Request, exc: Exception):  # pragma: no cover
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal error — logged for the operations team"})


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def root() -> str:
    """A deliberately plain landing page.

    The real interfaces are the four applications; this exists so a developer
    hitting the API origin gets orientation instead of a 404. It intentionally
    does not try to be the product.
    """
    db = SessionLocal()
    try:
        facilities = db.execute(select(Hospital)).scalars().all()
        api = sum(1 for h in facilities if h.integration is IntegrationMode.API)
    finally:
        db.close()
    projected = len(list(live_store.all()))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MedMesh API</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; background:#0f1115; color:#e7e9ee;
    font:14px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    display:flex; align-items:center; justify-content:center; padding:32px; }}
  .wrap {{ width:100%; max-width:680px; }}
  .brand {{ display:flex; align-items:center; gap:10px; margin-bottom:22px; }}
  .mark {{ width:26px; height:26px; }}
  h1 {{ font-size:19px; font-weight:600; letter-spacing:-0.01em; margin:0; }}
  .sub {{ color:#8b93a7; font-size:12.5px; margin-top:2px; }}
  .card {{ background:#161a21; border:1px solid #242a35; border-radius:10px; padding:18px 20px; }}
  .row {{ display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #1d222b; }}
  .row:last-child {{ border-bottom:0; }}
  .row span:first-child {{ color:#8b93a7; }}
  .row span:last-child {{ font-variant-numeric:tabular-nums; }}
  .ok {{ color:#3fb950; }}
  a {{ color:#6ea8fe; text-decoration:none; }}
  a:hover {{ text-decoration:underline; }}
  ul {{ list-style:none; padding:0; margin:18px 0 0; display:grid; gap:8px; }}
  li a {{ display:flex; justify-content:space-between; align-items:center; background:#161a21;
    border:1px solid #242a35; border-radius:8px; padding:11px 14px; color:#e7e9ee; }}
  li a:hover {{ border-color:#38404f; text-decoration:none; }}
  li small {{ color:#8b93a7; font-size:11.5px; }}
  code {{ background:#1d222b; padding:1px 5px; border-radius:4px; font-size:12.5px; }}
</style></head><body><div class="wrap">
  <div class="brand">
    <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="#6ea8fe" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12h4l2-5 3 10 2.5-5H21"/>
    </svg>
    <div><h1>MedMesh API</h1><div class="sub">Real-time healthcare capacity exchange · v1.0.0</div></div>
  </div>
  <div class="card">
    <div class="row"><span>Service</span><span class="ok">operational</span></div>
    <div class="row"><span>Facilities on network</span><span>{len(facilities)}</span></div>
    <div class="row"><span>Live projection</span><span>{projected} facilities</span></div>
    <div class="row"><span>Connector-integrated</span><span>{api} of {len(facilities)}</span></div>
    <div class="row"><span>WebSocket subscribers</span><span>{live_store.subscriber_count}</span></div>
  </div>
  <ul>
    <li><a href="/docs"><span>API reference<small style="display:block">OpenAPI · every endpoint, live</small></span><span>→</span></a></li>
    <li><a href="/api/v1/hospitals"><span>Public directory<small style="display:block">GET /api/v1/hospitals</small></span><span>→</span></a></li>
    <li><a href="/api/v1/analytics/overview"><span>District rollup<small style="display:block">GET /api/v1/analytics/overview</small></span><span>→</span></a></li>
  </ul>
  <p style="color:#8b93a7;font-size:12px;margin-top:20px">
    Interface clients: <code>apps/web</code> (portal, hospital, dispatch, government) and
    <code>apps/mobile</code> (Expo — crew app + companion views).
  </p>
</div></body></html>"""
