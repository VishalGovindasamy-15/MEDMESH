"""Notifications: the worklist that makes the rest of the system arrive.

A dashboard is a pull interface. It only works for someone already looking at
it, which is the wrong assumption for a ward at 3am: the whole point of a
two-way prep alert is that it reaches staff who are not currently staring at a
screen. So every event that needs a human to act lands here as a durable row,
and the WebSocket push is a live-update convenience layered on top rather than
the mechanism itself.

Addressing is deliberately simple: a notification belongs to a facility *or* to
a user, never both. Facilities receive operational traffic (an ambulance is
inbound, your hold is expiring, your data is stale); users receive
account-scoped traffic (your verification was decided, your submission was
quarantined).
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Hospital, Incident, Notification, NotificationKind, User, UserRole, utcnow

# How long an unacknowledged notification stays in the inbox before it is
# treated as stale. Not deleted -- an inbound alert that nobody read is exactly
# the sort of thing a review needs to be able to find later.
RETENTION_DAYS = 30

log = logging.getLogger("medmesh.notifications")


def notify_facility(
    db: Session,
    *,
    hospital_id: int,
    kind: NotificationKind,
    title: str,
    body: str = "",
    severity: str = "info",
    incident_id: int | None = None,
    payload: dict | None = None,
) -> Notification:
    row = Notification(
        kind=kind,
        hospital_id=hospital_id,
        title=title,
        body=body,
        severity=severity,
        incident_id=incident_id,
        payload=json.dumps(payload or {}, default=str)[:1000],
    )
    db.add(row)
    db.flush()
    return row


def notify_user(
    db: Session,
    *,
    user_id: int,
    kind: NotificationKind,
    title: str,
    body: str = "",
    severity: str = "info",
    incident_id: int | None = None,
    hospital_ref: int | None = None,
    payload: dict | None = None,
) -> Notification:
    row = Notification(
        kind=kind,
        user_id=user_id,
        title=title,
        body=body,
        severity=severity,
        incident_id=incident_id,
        hospital_ref=hospital_ref,
        payload=json.dumps(payload or {}, default=str)[:1000],
    )
    db.add(row)
    db.flush()
    return row


def notify_facility_staff(
    db: Session,
    *,
    hospital_id: int,
    kind: NotificationKind,
    title: str,
    body: str = "",
    severity: str = "info",
    incident_id: int | None = None,
    payload: dict | None = None,
) -> list[Notification]:
    """Fan a facility notification out to every admin of that facility.

    The facility row is written first so the inbox is complete even if a staff
    account is added later or removed, and so a hospital with no user accounts
    (a manual facility mid-onboarding) still has a record of what it was told.
    """
    rows = [
        notify_facility(
            db,
            hospital_id=hospital_id,
            kind=kind,
            title=title,
            body=body,
            severity=severity,
            incident_id=incident_id,
            payload=payload,
        )
    ]
    staff = db.execute(
        select(User).where(
            User.hospital_id == hospital_id,
            User.role.in_((UserRole.HOSPITAL_ADMIN, UserRole.PLATFORM_ADMIN)),
            User.is_active.is_(True),
        )
    ).scalars().all()
    for user in staff:
        rows.append(
            notify_user(
                db,
                user_id=user.id,
                kind=kind,
                title=title,
                body=body,
                severity=severity,
                incident_id=incident_id,
                payload=payload,
            )
        )
    return rows


def inbox(
    db: Session,
    *,
    user: User,
    unread_only: bool = False,
    limit: int = 50,
) -> list[Notification]:
    """Everything addressed to this user, plus everything addressed to their
    facility when they belong to one.

    A hospital admin sees the ward's traffic; a dispatcher sees only what was
    addressed to them personally, because they are not responsible for any
    facility's inbox.

    A platform operator is the exception and sees the whole estate's traffic.
    They already hold every facility's capacity, connectors and audit trail, so
    scoping their inbox to nothing would not protect anyone — it would just mean
    the one person who can act on a facility-wide failure is the last to hear
    about it.
    """
    conditions = [Notification.user_id == user.id]
    if user.hospital_id is not None:
        conditions.append(Notification.hospital_id == user.hospital_id)

    from sqlalchemy import or_

    if user.role is UserRole.PLATFORM_ADMIN:
        stmt = select(Notification).where(or_(*conditions, Notification.hospital_id.is_not(None)))
    else:
        stmt = select(Notification).where(or_(*conditions))
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    stmt = stmt.order_by(Notification.created_at.desc()).limit(limit)
    return list(db.execute(stmt).scalars().all())


def unread_count(db: Session, *, user: User) -> int:
    return len(inbox(db, user=user, unread_only=True, limit=200))


KIND_LABELS: dict[NotificationKind, str] = {
    NotificationKind.INBOUND_PATIENT: "Inbound patient",
    NotificationKind.HOLD_PLACED: "Bed hold placed",
    NotificationKind.HOLD_EXPIRING: "Bed hold expiring",
    NotificationKind.HOLD_RELEASED: "Bed hold released",
    NotificationKind.STALENESS_REMINDER: "Update your figures",
    NotificationKind.SUBMISSION_QUARANTINED: "Submission quarantined",
    NotificationKind.FEEDBACK_RAISED: "Complaint logged",
    NotificationKind.VERIFICATION_DECIDED: "Verification decision",
    NotificationKind.SURGE_OPENED: "Surge declared",
    NotificationKind.SURGE_CLOSED: "Surge stood down",
    NotificationKind.CONNECTOR_FAILING: "Connector failing",
}


def notification_out(
    row: Notification,
    *,
    hospital: Hospital | None = None,
    incident_reference: str | None = None,
) -> dict:
    """Wire shape for the inbox.

    The label, the facility name and the incident reference are resolved here
    rather than in the client: an inbox row has to be readable on its own — a
    ward clerk should not have to know that `staleness_reminder` means "go and
    count your beds", nor chase an id to find out which case an alert is about.
    """
    payload: dict | None = None
    if row.payload:
        try:
            payload = json.loads(row.payload)
        except (TypeError, ValueError):
            payload = None

    return {
        "id": row.id,
        "kind": row.kind.value,
        "kind_label": KIND_LABELS.get(row.kind, row.kind.value.replace("_", " ").title()),
        "title": row.title,
        "body": row.body,
        "severity": row.severity,
        "hospital_id": row.hospital_id,
        "hospital_name": hospital.short_name if hospital else None,
        "incident_id": row.incident_id,
        "incident_reference": incident_reference,
        "payload": payload,
        "created_at": row.created_at.isoformat() + "Z",
        "read_at": row.read_at.isoformat() + "Z" if row.read_at else None,
        "age_seconds": int((utcnow() - row.created_at).total_seconds()),
        "acknowledged_by": row.acknowledged_by,
    }


def notify_inbound(db: Session, incident: Incident, *, hospital: Hospital, eta_minutes: int, hold_resource: str | None) -> list[Notification]:
    """The two-way prep alert from §6.4, in the ward's own inbox.

    Non-clinical fields only: what is coming, how urgent, how long until it
    arrives, and which bed is being held for it. No patient detail exists to
    include, which is the point.
    """
    needs = []
    if incident.requires_icu:
        needs.append("ICU")
    if incident.requires_ventilator:
        needs.append("ventilator")
    if incident.requires_blood:
        needs.append("blood")
    need_text = f" Requires: {', '.join(needs)}." if needs else ""

    hold_text = f" {hold_resource.upper()} bed held." if hold_resource else ""

    return notify_facility_staff(
        db,
        hospital_id=hospital.id,
        kind=NotificationKind.INBOUND_PATIENT,
        title=f"Inbound {incident.urgency.value} · {incident.category.value.replace('_', ' ')} · ETA {eta_minutes} min",
        body=(
            f"{incident.reference} is en route to {hospital.short_name}.{need_text}{hold_text} "
            f"Reported: {incident.patient_state.value.replace('_', ' ')}."
        ).strip(),
        severity="critical" if incident.urgency.value == "P1" else "warm",
        incident_id=incident.id,
        payload={"eta_minutes": eta_minutes, "hold_resource": hold_resource},
    )


def stale_facilities(db: Session, *, threshold_minutes: int = 120) -> list[Hospital]:
    """Facilities that have not reported inside the reminder window.

    This is the §6.2 scheduled nudge. It reads the same freshness clock the
    directory badges use, so a facility cannot be "stale" on the public page
    while being considered current by the reminder job.
    """
    from ..models import CapacityRecord

    cutoff = utcnow() - timedelta(minutes=threshold_minutes)
    stale: list[Hospital] = []
    for hospital in db.execute(select(Hospital)).scalars().all():
        latest = db.execute(
            select(CapacityRecord.recorded_at)
            .where(CapacityRecord.hospital_id == hospital.id)
            .order_by(CapacityRecord.recorded_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if latest is None or latest <= cutoff:
            stale.append(hospital)
    return stale


def remind_stale(db: Session, *, threshold_minutes: int = 120) -> list[Notification]:
    """Queue a reminder per stale facility, at most one per facility per window."""
    created: list[Notification] = []
    for hospital in stale_facilities(db, threshold_minutes=threshold_minutes):
        recent = db.execute(
            select(Notification)
            .where(
                Notification.hospital_id == hospital.id,
                Notification.kind == NotificationKind.STALENESS_REMINDER,
                Notification.created_at >= utcnow() - timedelta(minutes=threshold_minutes),
            )
            .limit(1)
        ).scalar_one_or_none()
        if recent:
            continue

        created.append(
            notify_facility_staff(
                db,
                hospital_id=hospital.id,
                kind=NotificationKind.STALENESS_REMINDER,
                title="Bed figures need re-confirming",
                body=(
                    "Your published capacity has not been updated recently. Dispatch decisions "
                    "are made on these numbers, and a stale facility is ranked below one that "
                    "has reported. Use the quick-update keypad to confirm."
                ),
                severity="warm",
            )
        )
    return created


def send_email(*, to: str, subject: str, body: str, sensitive: bool = False) -> bool:
    """Outbound mail.

    The pilot has no mail transport, so this logs the fact of a send and returns.
    It exists as a function so that the production wiring is a one-line change
    here rather than an edit at every call site, and so that the *absence* of a
    transport is visible: a caller can tell the difference between "delivered"
    and "no transport configured" instead of assuming the message went out.

    `sensitive` marks bodies that must not be written to the log. The reset link
    is the reason the parameter exists -- a token in the log file is a token in
    every backup of the log file.
    """
    if sensitive:
        log.info("outbound email suppressed from logs (sensitive) to %s — %s", _mask(to), subject)
    else:
        log.info("outbound email to %s — %s", _mask(to), subject)
        log.debug("email body: %s", body[:200])
    return False  # no transport configured


def deliver_reset_link(db: Session, user: User, *, token: str, ttl_minutes: int) -> None:
    """Issue a password-reset link to the account holder.

    Goes through this module rather than sending from the router so that the
    pilot's no-op transport and a production mail provider are the same call
    site. The link is passed to `send_email` and deliberately *not* stored:

    the operator inbox is readable by platform administrators, so a persisted
    token would turn the inbox into a credential store -- an administrator could
    take over any account by reading the queue rather than by using the accounts
    API, which at least records what they did.

    The inbox entry therefore says that a reset was requested, and the token
    travels only over the delivery channel.
    """
    link_base = "medmesh://reset"
    send_email(
        to=user.email,
        subject="MedMesh password reset",
        body=(
            f"A password reset was requested for {user.email}.\n\n"
            f"Open this link within {ttl_minutes} minutes to choose a new password:\n"
            f"{link_base}?token={token}\n\n"
            "If this was not you, no action is needed: your password is unchanged "
            "and the link expires on its own."
        ),
        sensitive=True,
    )
    notify_user(
        db,
        user_id=user.id,
        kind=NotificationKind.AUTH_PASSWORD_RESET,
        title="Password reset requested",
        body=(
            f"A reset link was sent to {_mask(user.email)} and expires in {ttl_minutes} minutes. "
            "If you did not request it, tell your platform administrator."
        ),
        severity="warm",
    )


def _mask(email: str) -> str:
    """Enough of an address to recognise, not enough to harvest."""
    local, _, domain = email.partition("@")
    if not domain:
        return "***"
    keep = local[:2]
    return f"{keep}{'*' * max(1, len(local) - 2)}@{domain}"
