#!/bin/bash
cd "$(dirname "$0")"
(sleep 1; open http://localhost:4321) &
node server.js
