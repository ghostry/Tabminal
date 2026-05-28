FROM docker.m.daocloud.io/library/node:latest
# FROM docker.1ms.run/library/node:latest

ENV DEBIAN_FRONTEND=noninteractive
RUN sed -i 's|URIs: http://deb\.debian\.org/debian|URIs: http://mirrors.aliyun.com/debian|' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's|URIs: http://deb\.debian\.org/debian-security|URIs: http://mirrors.aliyun.com/debian-security|' /etc/apt/sources.list.d/debian.sources && \
    apt update -y;\
    apt install ripgrep sudo vim screen htop iotop iftop docker-cli jq sshpass fonts-wqy-microhei xz-utils build-essential rsync psmisc aria2 musl-tools -y;\
    apt clean

WORKDIR /app

RUN userdel -f -r node 2>/dev/null || true; \
    useradd -u 1000 -m -d /home/coder -s /bin/bash coder && \
    groupadd -f -g 997 docker && \
    usermod -aG docker coder && \
    echo "coder ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/coder

COPY package.json package-lock.json ./

RUN npm install

ENV NPM_CONFIG_PREFIX=/home/coder/.npm-g
ENV PATH=/home/coder/.npm-g/bin:$PATH
ENV PORT=9846
ENV HOST=0.0.0.0
ENV PASSWORD=admin

# Expose the default port
EXPOSE 9846

COPY . .

USER coder

# Default command (can be overridden)
CMD ["/app/start.sh"]
