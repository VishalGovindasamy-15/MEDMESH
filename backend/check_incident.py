from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.models import Incident

engine = create_engine('sqlite:///medmesh.sqlite3')
with Session(engine) as db:
    inc = db.get(Incident, 310)
    print(f"Incident 310: casualty_count={inc.casualty_count if inc else 'NOT FOUND'}")
