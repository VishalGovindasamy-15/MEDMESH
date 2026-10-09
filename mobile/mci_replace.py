import re

with open("app/console/mci/[id].tsx", "r") as f:
    content = f.read()

content = content.replace("<Select", "<Segmented scroll size=\"sm\"")

with open("app/console/mci/[id].tsx", "w") as f:
    f.write(content)
