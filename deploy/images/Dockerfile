FROM node:22-bookworm-slim
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-venv python3-pip default-jre-headless procps ca-certificates && rm -rf /var/lib/apt/lists/* \
    && usermod -l developer node && mkdir -p /home/developer && chown 1000:1000 /home/developer
ENV HOME=/home/developer
ENV PATH=/home/developer/.local/bin:/home/developer/.npm-global/bin:$PATH
ENV NPM_CONFIG_PREFIX=/home/developer/.npm-global
WORKDIR /home/developer
USER 1000:1000
CMD ["sleep", "infinity"]
