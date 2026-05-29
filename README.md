# `t>` Tabminal CODE

此项目基于 [Tabminal](https://github.com/Leask/Tabminal) 改版

## 介绍
当前AI开发盛行，开发模式正在从手写代码变成AI写代码，人工审计，调整，
人不再需要大量修改代码，codeserver就显得太重了，
我们的需求变成了一个稳定的终端 + 简单的文件管理 + 简单的git管理

## 快速开始
npm 全局定义为 /home/coder/.npm-global 执行时无需sudo

```
git clone https://github.com/ghostry/Tabminal
cd Tabminal
./build.sh
docker run -d --restart=always \
    -p 7083:7083 \
    -v $PWD/data:/home/coder \
    -e PASSWORD="admin" \
    -e PORT=7083 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --group-add docker \
    --name=tabminal \
    tabminal:latest
```
