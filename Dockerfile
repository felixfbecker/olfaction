FROM node:13.6.0

COPY . /srv/olfaction
WORKDIR /srv/olfaction
RUN npm ci
RUN npm run build

ENV PORT=80

EXPOSE 80
ENTRYPOINT [ "node", "out/server.js" ]
