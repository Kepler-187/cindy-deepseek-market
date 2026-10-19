'use strict';

/**
 * Cindy 插件沙箱侧入口。
 * Cindy 把模型发起的工具调用以 { type: 'tool-call', tool, args, callId } 发进来，
 * 这里转给本地 Node worker（node/worker.cjs）执行，再把结果回传。
 */

var METHOD_BY_TOOL = {
  deepseek_search: 'deepseek/search',
  deepseek_fetch: 'deepseek/fetch',
  deepseek_status: 'deepseek/status',
};

var TIMEOUT_BY_TOOL = {
  deepseek_search: 90000,
  deepseek_fetch: 90000,
  deepseek_status: 30000,
};

function fail(callId, errorCode, message) {
  return cindy.send({
    type: 'tool-result',
    callId: callId,
    ok: false,
    errorCode: errorCode,
    message: message,
  });
}

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;

  var method = METHOD_BY_TOOL[msg.tool];
  if (!method) {
    await fail(msg.callId, 'UNKNOWN_TOOL', '不支持的工具：' + String(msg.tool));
    return;
  }

  try {
    if (!cindy.node || typeof cindy.node.request !== 'function') {
      throw new Error('NODE_UNAVAILABLE');
    }

    var response = await cindy.node.request({
      method: method,
      callId: msg.callId,
      cancelWithCall: true,
      params: msg.args || {},
      timeoutMs: TIMEOUT_BY_TOOL[msg.tool] || 90000,
    });

    var data = response && response.ok ? response.result : null;
    if (!data || !data.ok) {
      await fail(
        msg.callId,
        (data && data.errorCode) || 'NODE_FAILED',
        (data && data.message) || (response && response.message) || 'DeepSeek 搜索插件未返回结果。'
      );
      return;
    }

    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: true,
      result: {
        text: data.text,
        results: data.results,
        meta: data.meta,
      },
    });
  } catch (error) {
    await fail(
      msg.callId,
      'OUTCOME_UNKNOWN',
      'DeepSeek 搜索插件运行失败：' +
        (error && error.message ? error.message : String(error)) +
        '。请检查插件状态与 DEEPSEEK_API_KEY 后重试。'
    );
  }
});
