#!/bin/bash
cd $(dirname $(readlink -f "$0"))

CRONTAB_DIR="/home/coder/.tabminal/crontabs"
mkdir -p "$CRONTAB_DIR"
sudo chown root:crontab "$CRONTAB_DIR"
sudo chmod 1730 "$CRONTAB_DIR"
if [ ! -L /var/spool/cron/crontabs ]; then
  sudo rm -rf /var/spool/cron/crontabs
fi
sudo ln -sf "$CRONTAB_DIR" /var/spool/cron/crontabs

sudo cron
sudo chmod 666 /run/docker.sock
npm start -- --accept-terms -a $PASSWORD -p $PORT -h $HOST
