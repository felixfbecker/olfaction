FROM node:13.8.0

# Build newer version of git from source
RUN apt-get update && \
  apt-get install -y dh-autoreconf libcurl4-gnutls-dev libexpat1-dev gettext libz-dev libssl-dev && \
  git clone --depth 1 --branch v2.25.0 git://git.kernel.org/pub/scm/git/git.git && \
  cd git && \
  make configure && \
  ./configure --prefix=/usr && \
  make all && \
  make install

# Install npm dependencies
COPY ./package*.json /srv/olfaction/
WORKDIR /srv/olfaction
RUN npm ci && npm cache clear -f

# Build server from source
COPY ./ /srv/olfaction/
RUN npm run build

ENV HOST=0.0.0.0
EXPOSE 4040

CMD [ "node", "out/server.js" ]
