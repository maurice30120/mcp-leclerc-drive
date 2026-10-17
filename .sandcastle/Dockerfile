FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

RUN npm install -g @openai/codex@0.141.0

USER ${AGENT_UID}:${AGENT_GID}

RUN curl https://cursor.com/install -fsS | bash

ENV PATH="/home/agent/.local/bin:$PATH"
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
