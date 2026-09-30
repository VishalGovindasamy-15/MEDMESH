"""Audit trail writer.

Every mutation calls `record()`. The table is append-only by convention -- there
is no update or delete path in the codebase -- which is what makes it usable as
evidence during a post-incident review.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from ..models import AuditLog, User


def record(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: str | int,
    summary: str = "",
    actor: User | None = None,
    payload: Any = None,
    ip: str | None = None,
    commit: bool = False,
) -> AuditLog:
    entry = AuditLog(
        actor_id=actor.id if actor else None,
        actor_label=actor.full_name if actor else "system:simulator",
        actor_role=actor.role.value if actor else "system",
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id),
        summary=summary[:300],
        payload=json.dumps(payload, default=str, separators=(",", ":"))[:20000] if payload is not None else "",
        ip=ip,
    )
    db.add(entry)
    if commit:
        db.commit()
    return entry


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Only the fields that actually moved. Keeps the audit payload readable and
    stops the table from ballooning with identical snapshots."""
    out: dict[str, Any] = {}
    for k, v in after.items():
        if before.get(k) != v:
            out[k] = {"from": before.get(k), "to": v}
    return out


def hash_secret(raw: str) -> str:
    """One-way hash for bearer secrets that are stored at rest.

    Used for password-reset tokens. They are 256 bits of `secrets.token_urlsafe`
    entropy, so a fast hash is the right primitive here: brute force is not a
    threat against a value nobody can guess, and the expensive KDF is reserved
    for passwords, where a human's choice is the weak part. Hashing at all is
    what matters -- a dump of the users table must not contain working reset
    links.
    """
    import hashlib

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
