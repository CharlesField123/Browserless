# Self-contained build for this fork, used by railway.json.
#
# docker/chromium/Dockerfile (the upstream image this fork started from)
# builds FROM ghcr.io/browserless/base:$VERSION — browserless.io's own
# prebuilt base image, whose node_modules were installed from *their*
# unmodified package.json. This fork's package.json adds two dependencies
# (@modelcontextprotocol/sdk, zod) for the /mcp endpoint that upstream's
# base image doesn't have, and docker/chromium/Dockerfile never re-runs
# `npm install` — it only COPYs src/ and builds. So it silently ships a
# server that 500s the moment /mcp is hit, missing those packages.
#
# This Dockerfile inlines docker/base/Dockerfile's setup (Node, apt
# packages, fonts) so `npm clean-install` runs against *this repo's*
# package.json/package-lock.json, then follows the same builder/runtime
# split as docker/chromium/Dockerfile, plus copies job-sourcing/ into the
# runtime image so the /mcp endpoint's dynamic imports of it succeed.
#
# If you don't need /mcp — e.g. deploying just the vanilla Browserless
# server — docker/chromium/Dockerfile is lighter (reuses the published
# base image layer) and works fine, since job-sourcing/'s CLI can point
# BROWSERLESS_WS_URL at any deployment.

ARG DEBIAN_FRONTEND=noninteractive
ARG TZ=America/Los_Angeles
ARG BLESS_USER_ID=999
ARG APP_DIR=/usr/src/app
ARG NODE_VERSION=v24.19.0
ARG NPM_VERSION=11.19.0

# ============================================================
# Base stage: mirrors docker/base/Dockerfile, but installs this repo's
# own package.json/package-lock.json instead of pulling a prebuilt image.
# ============================================================
FROM ubuntu:24.04 AS base
LABEL org.opencontainers.image.source=https://github.com/browserless/browserless

ARG DEBIAN_FRONTEND
ARG TZ
ARG BLESS_USER_ID
ARG APP_DIR
ARG NODE_VERSION
ARG NPM_VERSION

ENV NODE_VERSION=$NODE_VERSION
ENV NVM_DIR=/usr/src/.nvm
ENV NODE_PATH=$NVM_DIR/versions/node/$NODE_VERSION/bin
ENV PATH=$NODE_PATH:$PATH
ENV APP_DIR=$APP_DIR
ENV TZ=$TZ
ENV DEBIAN_FRONTEND=$DEBIAN_FRONTEND
ENV HOST=0.0.0.0
ENV PORT=3000
ENV LANG="C.UTF-8"
ENV DEBUG_COLORS=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/bin/playwright-browsers

RUN mkdir -p $APP_DIR $NVM_DIR && \
  groupadd -r blessuser && useradd --uid ${BLESS_USER_ID} -r -g blessuser -G audio,video blessuser && \
  mkdir -p /home/blessuser/Downloads && \
  chown -R blessuser:blessuser /home/blessuser

WORKDIR $APP_DIR

COPY fonts/* /usr/share/fonts/truetype/
COPY fonts/fonts.conf /etc/fonts/local.conf

RUN apt-get update \
  && apt-get install -y --no-install-recommends software-properties-common \
  && add-apt-repository universe \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dumb-init \
  git \
  gnupg \
  libu2f-udev \
  ssh \
  unzip \
  wget \
  xvfb \
  libwebp-dev \
  python3 python3-pip python3-setuptools \
  fontconfig \
  fonts-freefont-ttf \
  fonts-gfs-neohellenic \
  fonts-indic \
  fonts-ipafont-gothic \
  fonts-kacst \
  fonts-liberation \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  fonts-roboto \
  fonts-thai-tlwg \
  fonts-ubuntu \
  fonts-wqy-zenhei \
  fonts-open-sans \
  fonts-crosextra-carlito \
  fonts-dejavu-core \
  && update-alternatives --install /usr/bin/pip pip /usr/bin/pip3 1 \
  && update-alternatives --install /usr/bin/python python /usr/bin/python3 1 \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /usr/share/fonts/truetype/noto

RUN curl -sL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash &&\
  . $NVM_DIR/nvm.sh &&\
  nvm install $NODE_VERSION &&\
  npm install -g npm@$NPM_VERSION

COPY package.json package-lock.json ./

RUN npm clean-install

# NODE_ENV is set after npm clean-install so devDependencies are present in
# this base stage; the runtime stage below runs `npm prune --omit=dev`.
ENV NODE_ENV=production

COPY assets assets
COPY bin bin
COPY extensions extensions
COPY external external
COPY scripts scripts
COPY static static

COPY CHANGELOG.md LICENSE NOTICE.txt README.md tsconfig.json ./

EXPOSE $PORT

# ============================================================
# Builder stage: compile TypeScript, generate static + extension
# assets, install the debugger.
# ============================================================
FROM base AS builder

COPY src src/

RUN npm run build && \
    npm run build:function && \
    npm run install:debugger

# ============================================================
# Runtime stage: production-only deps + Chromium + built artifacts +
# the job-sourcing/ toolkit.
# ============================================================
FROM base

RUN npm prune --omit=dev

# NOTE it's important to not use npx playwright-core here since it'll likely install
# a more recent version than we potentially have in our own package.json
RUN ./node_modules/playwright-core/cli.js install --with-deps chromium && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Pull built artifacts from builder.
COPY --from=builder $APP_DIR/build ./build
COPY --from=builder $APP_DIR/static ./static
COPY --from=builder $APP_DIR/extensions ./extensions

# job-sourcing/ ships as plain, uncompiled ESM (see job-sourcing/README.md)
# and is loaded via dynamic import from src/mcp/job-sourcing.ts at request
# time — it needs no build step, just to be present on disk. Its
# node_modules, data/, and personal config are excluded via .dockerignore;
# it resolves puppeteer-core from $APP_DIR/node_modules (Node's normal
# parent-directory module resolution).
COPY job-sourcing ./job-sourcing

RUN chown -R blessuser:blessuser $APP_DIR

USER blessuser

CMD ["./scripts/start.sh"]
