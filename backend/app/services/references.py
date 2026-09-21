"""Incident reference allocation.

Every incident carries a short reference that a call-taker reads aloud over the
radio -- "TN-2009-H4W". Being short and unambiguous is the entire point, and
that puts a hard ceiling on how much space there is to draw from: three
characters from a 24-symbol alphabet with O/0 and I/1 removed is 13,824
references per day.

That ceiling is fine. Drawing from it *without checking whether the reference is
already taken* is not. The birthday paradox does the rest of the damage: at 300
incidents in a day -- an ordinary day for one district -- the chance that two of
them land on the same suffix passes 95%. The unique constraint on the column
turns that from a harmless duplicate into an exception, and an exception thrown
from inside the simulator's loop, or from the middle of a live 108 call, is an
outage rather than a hiccup.

So allocation is check-then-take, with the unique constraint retained as the
backstop for the narrow window between the check and the insert rather than as
the thing that discovers the problem. Both producers -- the dispatcher console
and the ingest simulator -- allocate through here, because two generators
drawing from one small space without seeing each other is the same bug with
extra steps.
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Incident, utcnow

# Look-alike characters are deliberately absent: no O or 0, no I or 1, no S or
# 5. A reference is spoken aloud and written down by hand at the other end of a
# bad phone line, and a misheard character costs an ambulance.
ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679"

BASE_LENGTH = 3

# Reaching this without finding a free suffix means the day's space is not merely
# crowded but full, and widening the suffix is the correct response -- a longer
# reference is worse than a short one, but far better than a failed dispatch.
_WIDEN_AFTER = 25
_MAX_ATTEMPTS = 50


class ReferenceSpaceExhausted(RuntimeError):
    """No free reference could be allocated. Should be unreachable in practice:
    the widest suffix tried here is four characters, which is 331,776 values."""


def allocate_reference(db: Session, *, now=None) -> str:
    """Return an incident reference not already present in the database.

    The check is a lookup on the unique index, so it is cheap enough to run on
    every incident intake. Any pending (unflushed) incident in the session
    participates in the check, because SQLAlchemy autoflushes before the SELECT
    -- which matters for a caller that creates several incidents in one
    transaction.
    """
    day = now or utcnow()
    prefix = f"TN-{day:%d%m}-"

    for attempt in range(_MAX_ATTEMPTS):
        length = BASE_LENGTH + attempt // _WIDEN_AFTER
        suffix = "".join(secrets.choice(ALPHABET) for _ in range(length))
        candidate = f"{prefix}{suffix}"
        taken = db.execute(
            select(Incident.id).where(Incident.reference == candidate).limit(1)
        ).first()
        if taken is None:
            return candidate

    raise ReferenceSpaceExhausted(
        f"no free {prefix} reference in {_MAX_ATTEMPTS} attempts"
    )
