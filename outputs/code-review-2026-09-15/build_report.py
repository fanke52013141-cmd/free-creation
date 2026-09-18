from pathlib import Path
import datetime
import html
import json
import re
import subprocess
import zipfile

ROOT = Path('D:/software/free-creation')
OUT = ROOT / 'outputs/code-review-2026-09-15'
BASELINE = '555a77ec0d738f5d35c7b1a4d922391f61b93231'

def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, encoding='utf-8', errors='replace', check=False)
    return {'exitCode': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}

results = json.loads((OUT / 'tests-serial-final.json').read_text(encoding='utf-8-sig'))
head = git('rev-parse', 'HEAD')
remote = git('ls-remote', 'origin', 'refs/heads/main')
diff = git('diff', '--quiet', 'HEAD', '--')
index_diff = git('diff', '--cached', '--quiet')
tracking = git('rev-parse', 'refs/remotes/origin/main')
remote_hash = remote['stdout'].split()[0] if remote['exitCode'] == 0 and remote['stdout'] else None
summary = {
    'generatedAt': datetime.datetime.now().astimezone().isoformat(),
    'baseline': BASELINE,
    'sync': {
        'repository': 'https://github.com/fanke52013141-cmd/free-creation.git',
        'localHead': head['stdout'], 'serverMain': remote_hash,
        'headEqualsServer': head['stdout'] == remote_hash == BASELINE,
        'trackedWorktreeClean': diff['exitCode'] == 0,
        'indexClean': index_diff['exitCode'] == 0,
        'localTrackingRef': tracking['stdout'],
        'trackingCacheMatchesServer': tracking['stdout'] == remote_hash,
        'note': '使用服务器直接查询核验；本机跟踪引用多次刷新后仍读取旧值。未强推或修改业务代码。'
    },
    'review': {'confirmedFindings': 11, 'P1': 8, 'P2': 3, 'bugsFixed': 0},
    'typecheck': {'nodeExitCode': 0, 'webExitCode': 0},
    'lint': {'exitCode': 0, 'errors': 0, 'warnings': 129},
    'build': {'initial': 'memory allocation failed', 'retryExitCode': 0, 'rendererMainJsKB': 8833.63, 'rendererCssKB': 353.24, 'installerTested': False},
    'tests': {
        'total': results['numTotalTests'], 'passed': results['numPassedTests'],
        'failed': results['numFailedTests'], 'pending': results['numPendingTests'],
        'fileCount': len(results['testResults']),
        'passedFiles': sum(x['status'] == 'passed' for x in results['testResults']),
        'failedFiles': [
            {'file': str(Path(x['name']).relative_to(ROOT)) if str(x['name']).lower().startswith(str(ROOT).lower()) else x['name'],
             'failures': sum(a['status'] == 'failed' for a in x['assertionResults'])}
            for x in results['testResults'] if x['status'] != 'passed'
        ],
        'cause': 'better-sqlite3 NODE_MODULE_VERSION 140 versus Node requirement 127',
        'nativeDependencyRebuilt': False,
        'command': 'vitest run --maxWorkers=2 --no-file-parallelism --reporter=json'
    },
    'coverage': {'measured': False, 'configuredIncludeFiles': 8},
    'scope': {'sourceFiles': 237, 'sourceLinesIncludingBlankAndComments': 59169, 'testFilesIncludingHelper': 78, 'testLinesIncludingBlankAndComments': 13680},
    'limitations': ['未运行真实桌面端到端', '未调用真实模型服务', '未测试安装包', '未查询远端CI', '未运行依赖漏洞数据库扫描', '隔离验证不等于真实文件系统/GUI验证']
}
(OUT / '验证摘要.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
if not summary['sync']['headEqualsServer'] or not summary['sync']['trackedWorktreeClean'] or not summary['sync']['indexClean']:
    raise RuntimeError('最终源码一致性核验失败，请检查验证摘要')

markdown = (OUT / '代码审查报告.md').read_text(encoding='utf-8')

def inline(text):
    chunks = re.split(r'(`[^`]+`)', text)
    rendered = []
    for chunk in chunks:
        if chunk.startswith('`') and chunk.endswith('`'):
            code = chunk[1:-1]
            match = re.fullmatch(r'((?:src|test)/[^: ]+):(\d+)(.*)', code)
            if match:
                url = 'https://github.com/fanke52013141-cmd/free-creation/blob/' + BASELINE + '/' + match.group(1) + '#L' + match.group(2)
                rendered.append('<a class="source" href="' + html.escape(url, quote=True) + '" target="_blank" rel="noopener noreferrer"><code>' + html.escape(code) + '</code></a>')
            else:
                rendered.append('<code>' + html.escape(code) + '</code>')
        else:
            safe = html.escape(chunk)
            safe = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', safe)
            rendered.append(safe)
    return ''.join(rendered)

lines = markdown.splitlines()
blocks, toc = [], []
i = 0
section = 0
while i < len(lines):
    line = lines[i]
    if not line.strip():
        i += 1
        continue
    if line.startswith('# '):
        i += 1
        continue
    if line.startswith('> '):
        blocks.append('<p class="meta">' + inline(line[2:]) + '</p>')
        i += 1
        continue
    if line.startswith('## '):
        section += 1
        title = line[3:]
        anchor = 'section-' + str(section)
        toc.append((anchor, title))
        blocks.append('<h2 id="' + anchor + '">' + inline(title) + '</h2>')
        i += 1
        continue
    if line.startswith('### '):
        title = line[4:]
        cls = 'finding' if re.match(r'F\d+', title) else ''
        blocks.append('<h3 class="' + cls + '">' + inline(title) + '</h3>')
        i += 1
        continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                rows.append(cells)
            i += 1
        blocks.append('<div class="table-wrap"><table><thead><tr>' + ''.join('<th>' + inline(c) + '</th>' for c in rows[0]) + '</tr></thead><tbody>')
        for row in rows[1:]:
            blocks.append('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in row) + '</tr>')
        blocks.append('</tbody></table></div>')
        continue
    if line.startswith('- ') or re.match(r'^\d+\. ', line):
        ordered = not line.startswith('- ')
        tag = 'ol' if ordered else 'ul'
        blocks.append('<' + tag + '>')
        while i < len(lines) and (re.match(r'^\d+\. ', lines[i]) if ordered else lines[i].startswith('- ')):
            text = re.sub(r'^\d+\. ', '', lines[i]) if ordered else lines[i][2:]
            blocks.append('<li>' + inline(text) + '</li>')
            i += 1
        blocks.append('</' + tag + '>')
        continue
    blocks.append('<p>' + inline(line) + '</p>')
    i += 1

nav = ''.join('<a href="#' + anchor + '">' + html.escape(title) + '</a>' for anchor, title in toc)
css = '''
:root{color-scheme:light;--ink:#182c40;--muted:#5d6d7e;--line:#dce4e9;--accent:#17665f}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:#f3f6f8;color:var(--ink);font:15px/1.85 "Segoe UI","Microsoft YaHei",sans-serif}header{background:#fff;border-top:7px solid var(--accent);border-bottom:1px solid var(--line);padding:40px max(28px,calc((100vw - 1280px)/2)) 30px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--accent);font-weight:700}h1{font-size:34px;line-height:1.3;margin:12px 0}header p{margin:6px 0;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:26px}.stat{background:#f5f8fa;border:1px solid var(--line);border-radius:8px;padding:14px 18px}.stat b{font-size:28px;display:block;line-height:1.4}.stat span{font-size:13px;color:var(--muted)}.danger{color:#ad423a}.layout{max-width:1320px;margin:auto;display:grid;grid-template-columns:228px minmax(0,1fr);gap:30px;padding:28px 20px 60px}nav{position:sticky;top:20px;align-self:start;font-size:13px}nav a{display:block;color:var(--muted);text-decoration:none;padding:8px 10px;border-radius:5px;margin:2px 0}nav a:hover{background:#e3eeec;color:var(--accent)}nav .nav-label{font-size:11px;font-weight:700;letter-spacing:2px;margin:0 10px 12px;color:var(--accent)}article{background:white;padding:26px 38px 46px;border:1px solid var(--line);border-radius:10px;min-width:0}h2{font-size:24px;margin:42px 0 18px;border-bottom:2px solid #dae7e5;padding-bottom:10px}h2:first-of-type{margin-top:24px}h3{font-size:18px;margin:28px 0 14px}.finding{border-left:4px solid #c06355;background:#fff6f2;padding:12px 16px;border-radius:0 6px 6px 0;margin-top:38px}p{margin:14px 0}li{margin:7px 0}strong{color:#182c40}code{font:12.5px/1.6 Consolas,"Microsoft YaHei",monospace;background:#eef3f5;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}a.source{color:#17665f;text-decoration:none}a.source:hover{text-decoration:underline}.meta{font-size:12px;color:var(--muted)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:7px;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.65}th{background:#eaf1f1;color:#244a47;text-align:left;padding:12px}td{padding:11px 12px;vertical-align:top;border-top:1px solid var(--line)}tr:nth-child(even){background:#fafcfd}td:first-child{min-width:80px}footer{font-size:12px;color:var(--muted);margin-top:40px;border-top:1px solid var(--line);padding-top:18px}.actions{margin-top:16px;display:flex;gap:12px}.actions a{color:var(--accent);text-decoration:none;border:1px solid #accac5;background:#fff;border-radius:5px;padding:5px 12px;font-size:13px}
@media(max-width:920px){.layout{grid-template-columns:1fr}nav{position:static;display:flex;flex-wrap:wrap;gap:4px}nav .nav-label{display:none}article{padding:20px}.stats{grid-template-columns:repeat(2,1fr)}h1{font-size:28px}}@media print{body{background:white;font-size:11px}header{padding:16px 0}.layout{display:block;padding:0}nav,.actions{display:none}article{padding:0;border:0}.stats{margin-top:12px}h2{break-before:auto}h2,h3{break-after:avoid}tr{break-inside:avoid}.table-wrap{overflow:visible}a{color:inherit}code{font-size:10px}h1{font-size:25px}.stat b{font-size:22px}}
'''
document = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas Studio｜代码审查报告</title><style>' + css + '</style></head><body>'
document += '<header><div class="eyebrow">ENGINEERING REVIEW / 2026.09.15</div><h1>Canvas Studio 代码审查报告</h1><p>同步结果 · 可证实问题 · 验证证据 · 分阶段优化建议</p><div class="stats"><div class="stat"><b>555a77e</b><span>本地与服务器 main 一致</span></div><div class="stat"><b class="danger">11 项</b><span>8 项 P1 / 3 项 P2</span></div><div class="stat"><b>932 / 950</b><span>18 项因 SQLite ABI 不匹配失败</span></div><div class="stat"><b>构建通过</b><span>单独重试成功，未验收安装包</span></div></div><div class="actions"><a href="代码审查报告.md" download>下载 Markdown</a><a href="验证摘要.json">查看验证摘要</a></div></header>'
document += '<div class="layout"><nav aria-label="报告目录"><p class="nav-label">REPORT CONTENTS</p>' + nav + '</nav><article>' + '\n'.join(blocks) + '<footer>报告只读审查基线：' + BASELINE + '。本轮未修复业务代码。源码链接固定到审查提交。</footer></article></div></body></html>'
(OUT / '代码审查报告.html').write_text(document, encoding='utf-8')
archive_files = ['代码审查报告.html', '代码审查报告.md', '验证摘要.json', 'tests-serial-final.json', 'tests-serial-final.log', 'tests.log', 'lint.log', 'build.log', 'build-retry.log']
with zipfile.ZipFile(OUT / '代码审查报告及验证材料.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in archive_files:
        archive.write(OUT / name, name)
print(json.dumps({'sync': summary['sync'], 'tests': {k: summary['tests'][k] for k in ['total','passed','failed','fileCount']}, 'htmlSections': len(toc), 'deliverables': [{'name': name, 'bytes': (OUT / name).stat().st_size} for name in ['代码审查报告.html','代码审查报告.md','代码审查报告及验证材料.zip']]}, ensure_ascii=False, indent=2))
