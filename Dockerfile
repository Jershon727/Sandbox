# The relay only. The app itself is static files served by Firebase Hosting (or
# anything else); this image is just the small WebSocket server that lets phones
# share a room.
#
#   docker build -t flip7-relay .
#   docker run -p 8787:8787 flip7-relay
#
# On Fly / Render / Railway, pointing the service at this Dockerfile is enough —
# they set PORT and this respects it.

FROM node:22-alpine

WORKDIR /app

# `ws` is the only runtime dependency, and only the relay needs it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# room.js is imported by the relay for its merge semantics, so the server and
# the browsers can't disagree about what an update means.
COPY server ./server
COPY public/js/room.js ./public/js/room.js
COPY public/js/scoring.js ./public/js/scoring.js

ENV NODE_ENV=production
ENV PORT=8787

# Rooms are saved here so a restart doesn't end everyone's game. Mount a volume
# at /data to keep them across redeploys too.
ENV ROOM_STORE=/data/rooms.json
RUN mkdir -p /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/relay.mjs"]
