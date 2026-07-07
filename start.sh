#!/bin/bash
cd $(dirname $(readlink -f "$0"))
sudo cron
sudo chmod 666 /run/docker.sock
npm start -- --accept-terms -a $PASSWORD -p $PORT -h $HOST
