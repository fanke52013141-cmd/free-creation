#!/usr/bin/env python3
"""Agent Flow 主控决策失败根因隔离复现脚本（脱敏版）。

用途：证明官方智谱 glm-5.3 端点本身能稳定产出合法工具调用，
从而把"应用主控 AGENT_MODEL_FAILED"的根因锁定在应用侧集成，而非端点。

运行前设置环境变量（不要把密钥写进代码或提交到仓库）：
  $env:CANVAS_TEST_API_KEY = '<你的智谱 API Key>'
  # 可选覆盖：
  $env:CANVAS_TEST_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
  $env:CANVAS_TEST_MODEL = 'glm-5.3'
然后：python repro_glm.py

脚本只发小额文本探测请求（max_tokens 受限），会消耗少量额度。
"""
import json, os, sys, time, urllib.request, urllib.error

KEY = os.environ.get('CANVAS_TEST_API_KEY')
if not KEY:
    print('请先设置环境变量 CANVAS_TEST_API_KEY（智谱 API Key），再运行本脚本。')
    sys.exit(1)
BASE = os.environ.get('CANVAS_TEST_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4')
MODEL = os.environ.get('CANVAS_TEST_MODEL', 'glm-5.3')
URL = BASE.rstrip('/') + '/chat/completions'

REF = {'assetId': 'a1', 'versionId': 'v1', 'sourceNodeId': 'shape:src', 'sourcePortId': 'out-text'}

def ref_enum():
    return {'type': 'object',
            'properties': {k: {'type': 'string', 'enum': [REF[k]]} for k in REF},
            'required': list(REF), 'additionalProperties': False}

dispatch = {'type': 'function', 'function': {'name': 'dispatch_agent', 'description': '分派专业 Agent 任务',
    'parameters': {'type': 'object', 'properties': {
        'nodeId': {'type': 'string', 'enum': ['shape:sp_topic', 'shape:sp_research']},
        'goal': {'type': 'string'}, 'completion': {'type': 'string'},
        'inputs': {'type': 'array', 'items': ref_enum(), 'minItems': 1, 'maxItems': 32}},
        'required': ['nodeId', 'goal', 'completion', 'inputs'], 'additionalProperties': False}}}
finish = {'type': 'function', 'function': {'name': 'finish_flow', 'description': '完成后选择成果',
    'parameters': {'type': 'object', 'properties': {
        'outputs': {'type': 'array', 'items': ref_enum(), 'minItems': 1, 'maxItems': 128}},
        'required': ['outputs'], 'additionalProperties': False}}}

SYSTEM = '你是主 Agent，每轮必须选择恰好一个工具。按 goal 分派专家。'
CTX = {'goal': '产出公众号文章，按顺序分派选题→资料→框架→写作专家。', 'mode': 'autonomous',
       'available': [{'nodeId': 'shape:sp_topic', 'goal': '选题', 'inputs': [REF]}], 'completed': []}

def run(label, extra, tools=None):
    body = {'model': MODEL,
            'messages': [{'role': 'system', 'content': SYSTEM},
                         {'role': 'user', 'content': json.dumps(CTX, ensure_ascii=False)}],
            'tools': tools or [dispatch, finish], 'tool_choice': 'required', 'stream': True}
    body.update(extra)
    req = urllib.request.Request(URL, data=json.dumps(body).encode('utf-8'),
                                 headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time(); fr = None; tool = False; err = None
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            for line in r:
                line = line.decode('utf-8').strip()
                if not line.startswith('data:'):
                    continue
                p = line[5:].strip()
                if p == '[DONE]':
                    break
                try:
                    d = json.loads(p)
                except Exception:
                    continue
                if 'error' in d:
                    err = d['error']
                ch = d.get('choices', [{}])[0]
                if ch.get('finish_reason'):
                    fr = ch['finish_reason']
                if ch.get('delta', {}).get('tool_calls'):
                    tool = True
        print('[%s] %.1fs finish=%s tool_call=%s err=%s'
              % (label, time.time() - t, fr, tool, json.dumps(err, ensure_ascii=False)[:200] if err else 'None'))
    except urllib.error.HTTPError as e:
        print('[%s] HTTP %s %.1fs body=%s' % (label, e.code, time.time() - t, e.read().decode('utf-8')[:300]))
    except Exception as e:
        print('[%s] ERR %.1fs %s' % (label, time.time() - t, str(e)[:200]))

if __name__ == '__main__':
    print('endpoint=%s model=%s' % (URL, MODEL))
    run('A 复杂schema+required', {})
    run('B +thinking+effort低（应用注入参数）', {'thinking': {'type': 'enabled'}, 'reasoning_effort': 'low'})
    run('C +stream_options', {'stream_options': {'include_usage': True}})
    run('D 仅thinking', {'thinking': {'type': 'enabled'}})
    print('若以上均 finish=tool_calls tool_call=True，则端点正常，根因在应用侧集成。')