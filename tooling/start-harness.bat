@echo off
set IPROYAL_USER=iproyal1365
set IPROYAL_PASS=<set-in-environment>
cd /d C:\Users\google\Desktop\godrej\packages\orchestrator
echo Starting Traffic Armour Harness...
node dist/cli.js --scenario ..\..\scenarios\digitalserviceone-trivial-burst.yaml --dashboard-port 7474 --no-mitm
pause
