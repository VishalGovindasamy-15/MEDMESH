"""Runtime configuration.

Everything is overridable by environment variable so the same image can run as a
single-node pilot (SQLite + in-process pub/sub) or as the multi-AZ production
topology described in the architecture report (PostgreSQL + Redis + Kafka fan-out)
without a code change.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEDMESH_", env_file=".env", extra="ignore")

    app_name: str = "MedMesh"
    environment: str = "development"

    # --- Data layer -------------------------------------------------------
    # Pilot default is SQLite so the stack boots with zero external services.
    # Production sets MEDMESH_DATABASE_URL=postgresql+psycopg://...
    database_url: str = "sqlite+pysqlite:///./medmesh.db"
    sql_echo: bool = False

    # --- Auth -------------------------------------------------------------
    jwt_secret: str = "dev-only-secret-change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 60 * 12
    refresh_token_ttl_days: int = 14

    # Whether this deployment may publish its pilot credentials.
    #
    # The sign-in screen used to carry them as literal constants, which meant
    # every copy of the codebase shipped a working administrator password. They
    # are now served by the API only when this flag is on, and the flag defaults
    # to off -- so a deployment that forgets to configure it fails closed, with
    # an empty sign-in screen rather than a published one. The pilot turns it on;
    # the production compose file does not.
    demo_mode: bool = False

    # Echo a password-reset token in the HTTP response. Only ever meaningful
    # with no mail transport configured, which is the pilot's situation. Gated
    # separately from `demo_mode` because a demo instance may still want real
    # reset behaviour, and because tying them together would silently switch
    # this on wherever the demo flag is set.
    expose_password_reset_token: bool = False

    # --- Trust engine thresholds (minutes) --------------------------------
    freshness_live_minutes: int = 15
    freshness_warm_minutes: int = 60
    freshness_stale_minutes: int = 240

    # Anomaly detection: a single update is quarantined for review when it moves
    # a count by at least `anomaly_abs_delta` AND at least `anomaly_pct_delta`
    # of the previous value.
    #
    # AND, not OR, and this comment previously said OR while the implementation
    # used AND — which is the kind of disagreement that gets "fixed" in the wrong
    # direction by whoever reads the comment next. It is AND because either
    # threshold alone produces false positives on real data:
    #
    #   * absolute alone flags 12 beds rising to 25 at a 900-bed hospital, which
    #     is an ordinary morning discharge round;
    #   * percentage alone flags 2 beds rising to 4 at a small clinic, which is
    #     one admission.
    #
    # Requiring both means a jump has to be large in absolute terms *and* large
    # relative to what the facility previously reported before anyone is asked to
    # review it. A move that clears both is the 0 → 50 case the report describes.
    anomaly_abs_delta: int = 12
    anomaly_pct_delta: float = 0.45

    # --- Dispatch ---------------------------------------------------------
    default_hold_ttl_seconds: int = 900  # 15 min bed hold, per the report
    max_hold_ttl_seconds: int = 3600
    urban_speed_kmph: float = 34.0  # Coimbatore city traffic average
    highway_speed_kmph: float = 52.0
    road_winding_factor: float = 1.32  # straight-line -> road distance

    # --- Road routing ------------------------------------------------------ #
    # A *server* key, restricted by IP, used for Distance Matrix. This is
    # deliberately a different key from the browser key the frontend uses to
    # draw tiles: the browser key must be public to work, and a public key with
    # Distance Matrix enabled on it is an open billing account.
    google_maps_server_key: str | None = None
    routing_enabled: bool = True
    routing_timeout_seconds: float = 4.0
    # Distance between two fixed points is a property of the road network and
    # barely changes; duration is traffic and goes stale in minutes. Splitting
    # the TTLs is what keeps the cache useful without serving yesterday's
    # journey time during this morning's peak.
    routing_distance_ttl_minutes: int = 360
    routing_duration_ttl_minutes: int = 4
    routing_cache_entries: int = 5000
    # How far a candidate may be by *straight line* before it is not worth
    # asking the router about. Beyond this a facility cannot be within the
    # catchment by any road, because roads are never shorter than straight lines.
    routing_prefilter_km: float = 260.0

    # --- Synthetic feed ---------------------------------------------------
    # Drives the ingest simulator so the dashboards show real movement in a
    # demo. Disabled in tests and in production (real connectors take over).
    simulator_enabled: bool = True
    simulator_interval_seconds: float = 3.5
    # With the estate covering all 38 districts, three facilities per tick
    # leaves most of the state looking dead on the freshness column. The
    # figure is a proportion of connector-integrated facilities, so it
    # scales with the estate rather than being tuned per dataset.
    simulator_hospitals_per_tick: int = 14

    # --- Reachability reminder loop (staleness nudges to hospital staff) ---
    staleness_sweep_seconds: int = 45

    cors_origins: list[str] = ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
