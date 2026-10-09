import sqlite3
conn = sqlite3.connect('medmesh.db')
cur = conn.cursor()
cur.execute("SELECT id, reference, status, casualty_count FROM incidents WHERE id=325")
print(cur.fetchone())
