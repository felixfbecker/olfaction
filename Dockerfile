FROM node:12.10.0

COPY . /srv/olfaction
WORKDIR /srv/olfaction
RUN npm ci
RUN npm run build

EXPOSE 80
ENTRYPOINT [ "node", "out/server.js" ]
