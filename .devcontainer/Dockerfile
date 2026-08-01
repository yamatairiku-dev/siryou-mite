FROM node:24.18.0-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Tokyo \
    LANG=ja_JP.UTF-8

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
    wget \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && ln -fs /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
  && dpkg-reconfigure --frontend noninteractive tzdata \
  && echo "ja_JP.UTF-8 UTF-8" > /etc/locale.gen \
  && locale-gen ja_JP.UTF-8 \
  && echo "node ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node \
  && rm -rf /var/lib/apt/lists/*

USER node

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh

COPY --chown=node:node .devcontainer/git-branch-prompt.sh /home/node/.git-branch-prompt.sh
RUN echo '[ -f ~/.git-branch-prompt.sh ] && . ~/.git-branch-prompt.sh' >> ~/.bashrc

WORKDIR /workspace
