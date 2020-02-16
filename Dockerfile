FROM node:13.6.0

COPY ./package*.json /srv/olfaction/
WORKDIR /srv/olfaction
RUN npm ci && npm cache clear -f

COPY ./ /srv/olfaction/
RUN npm run build

ENV HOST=0.0.0.0
EXPOSE 4040

CMD [ "node", "out/server.js" ]
