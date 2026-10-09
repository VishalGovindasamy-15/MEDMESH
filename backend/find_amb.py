import sys
sys.path.append("/home/vishal/Projects/Medmesh/mv6/medmesh/backend")
from app.database import engine
from sqlalchemy.orm import Session
from app.models import Ambulance

with Session(engine) as db:
    ambs = db.query(Ambulance).filter(Ambulance.call_sign.like("%420%")).all()
    for a in ambs:
        print(a.call_sign, a.status.value)

