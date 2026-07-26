FROM node:24.18.0-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Tokyo \
    LANG=ja_JP.UTF-8 \
    DISABLE_AUTOUPDATER=1

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash-completion \
    build-essential \
    ca-certificates \
    curl \
    fzf \
    git \
    htop \
    jq \
    locales \
    openssl \
    python3 \
    sqlite3 \
    libsqlite3-dev \
    sudo \
    tmux \
    tzdata \
    vim \
  && ln -fs /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
  && dpkg-reconfigure --frontend noninteractive tzdata \
  && echo "ja_JP.UTF-8 UTF-8" > /etc/locale.gen \
  && locale-gen ja_JP.UTF-8 \
  && echo "node ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node \
  && rm -rf /var/lib/apt/lists/*

ARG CODEX_VERSION=0.145.0
ARG CLAUDE_CODE_VERSION=2.1.202

RUN npm install --global \
    "@openai/codex@${CODEX_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

USER node
WORKDIR /workspace
