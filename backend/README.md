# P3 服务端

这个服务端是模型凭据、画布快照、上传资产和视频长任务的唯一入口。浏览器不保存、也不发送 API Key。

## 启动

1. 复制 `.env.example` 为 `.env`，在系统环境变量或 `.env` 中设置 `MODEL_PROFILES_JSON` 与各 profile 的 `api_key_env`。
2. 安装依赖：`python -m pip install -r requirements.txt`
3. 运行：`python -m uvicorn app.main:app --reload --port 8010`
4. 前端开发服务器会把 `/api` 代理到 `http://127.0.0.1:8010`。如端口冲突，设置 `VITE_API_PROXY_TARGET` 后重启 Vite。

视频 profile 的任务状态接口由 `status_path_template` 明确配置，避免把不同供应商的任务协议硬编码在前端。当前 Seedance 适配器使用提交接口与轮询接口；若供应商的查询路径不同，只修改 profile 即可。

运行时数据库和资产在 `backend/data/`、`backend/project_storage/`，二者均被 Git 忽略。
