# 本机授权运维手册（避免反复被要求授权）

日期：2026-11-09。适用：本机开发/自用。发布包不受本文任何便捷开关影响。

---

## 一、为什么会被反复要求授权（根因）

授权是 **"设备 + 信任根"双绑定**：

```
授权文件(license-current.json) = 签名(授权内容 by 签发人私钥) + 签发人证书(by 根私钥)
应用校验 = 授权签名 → 签发人证书签名 → 根公钥（构建里固定 = trusted-root.generated.ts）
```

只要**根换了**（没有人重新 init-root 就不会换），旧根签发的所有授权立刻失效，
应用就会要求重新授权；而新根的**私钥往往只在生成它的那台机器上**——本机拿不到私钥，
就出现"签发不出来、只能一直卡在授权窗"的局面。

**2026-11-08/09 实际发生的事**（代码里有留痕）：

| 时间 | 事件 |
| --- | --- |
| 11-08 | 本机用开发根 `sha256-fb796e4f…` 完成激活，可正常使用 |
| 11-09 15:12 | 另一台机器上重新 `init-root`，`trusted-root.generated.ts` 换成新根 `sha256-f3f96c67…` 并提交 |
| 11-09 20:10 | 本机打开应用 → `CERT_CHAIN_INVALID`（旧授权不认新根）→ 又要求授权 |

结论：**根不换，就不会反复授权**。这是唯一根因。

---

## 二、现在的处理办法（已落地）

### 1. 本机开发配置（一次设置，长期有效）

仓库根目录下的 **`.canvas-license-dev.json`**（已 gitignore，不会入库）：

```json
{ "trustedRootStore": "qa/security-dev-root" }
```

未打包构建启动时会读它，用该目录的 `root.public.json` 作为信任根。
所以**即使仓库里提交了别的新根，本机开发照旧用本机持有的根**，不会再被要求授权。

> 只在 `app.isPackaged === false` 时生效；安装包/发行包一律用构建内固定根，不受影响。

### 2. 一条命令修复（万一还是被要求授权）

```powershell
npm run license:repair
```

它会：让未打包构建信任本机 store 的根 → 自动走完"导出申请 → 登记 → 挑战 → 证明 → 签发 → 导入"
→ 结束。全程约 20 秒，**不需要手点授权界面**。

### 3. 开发构建免授权开关（可选，仅调试用）

```powershell
$env:CANVAS_LICENSE_DEV_BYPASS = "1"; npm run dev
```

仅未打包构建生效，日志会写一条 warn 留痕。日常开发想完全不碰授权可以用它；
但验收授权链路本身时不要开。

### 4. 诊断与备份

```powershell
npm run license:check      # 看：构建信任根 / 本机 store 根 / 已存授权 / 备份 是否一致
npm run license:backup     # 把开发根私钥 store 复制到 C:\Users\<你>\.canvas-studio-license-root
npm run license:restore    # 换电脑/重装后先恢复，再别急着 init-root
```

---

## 三、铁律：关于开发根

1. **不要随手 `init-root`。** 一次 init-root = 所有旧授权作废，所有人都要重新激活。
2. **换机器先 `license:restore`**，不要 init-root。
3. 开发根私钥只在 `qa/security-dev-root/`（gitignored）。**换机前先 `license:backup`**，
   备份目录是 `C:\Users\<你>\.canvas-studio-license-root`（建议再拷一份到网盘/U 盘）。
4. 确实需要换根（例如私钥泄漏）时，按"换根流程"做：新根只生成一次 → 提交 `trusted-root.generated.ts`
   → 发通知 → 各机器 `init-root` 后重新签发一次。换根提交的说明里必须写清"旧根授权自本版起不再受信"。
5. 生产根私钥**绝不进仓库、不进构建机**；开发根也不要进仓库。
6. 发布包（`app.isPackaged`）不读任何本机覆盖配置，不受上面便捷开关影响。

---

## 四、换机 / 重装的标准步骤

```powershell
# 旧机器（离职/换机前）
npm run license:backup
# 把 C:\Users\<你>\.canvas-studio-license-root 整个目录拷到新机器同位置

# 新机器
git clone <repo>; cd source
npm run license:restore        # 恢复开发根（关键：别 init-root）
npm run build
npm run license:repair         # 用恢复的根签一张本机授权（设备绑定，必须在本机签）
# 然后把 .canvas-license-dev.json 写上本机 store 路径（仓库里没有，需一次配置）
```

设备绑定意味着**授权不能跨机器复制**，但**根可以**——所以换机只需搬根 + 重签一次。

---

## 五、如果本机确实没有对应私钥

只有两种正路（不要伪造、不要绕过）：

1. 从生成新根的那台机器拿 `root-signing.private.json` 与 `issuer-signing.private.json`
   （放进一个 store 目录，用 `--store` 指向它），然后 `npm run license:repair`；
2. 或者本机重新 init-root 并**接受代价**：所有基于旧根的授权作废（需要重新签发一遍）。

---

## 六、验收证据

- `npm run build` 后启动：授权窗消失，直接进入「无限画布创作平台」，画布加载出项目节点。
- `main.log` 出现：`license: 开发构建使用了信任根覆盖 store=… kid=sha256-fb796e4f…`
- `license-current.json` 的 `issuerCert.kid` = `sha256-fb796e4f…`（与 store 根一致）。
