#!/bin/bash
cd $(dirname $(readlink -f "$0"))
npm start -- --accept-terms -a $PASSWORD -p $PORT -h $HOST
sudo chmod 666 /run/docker.sock
