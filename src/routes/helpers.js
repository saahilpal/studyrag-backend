function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function fail(res, error, status = 400) {
  return res.status(status).json({ ok: false, error });
}

function setDeprecationHeaders(res, replacementPath) {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
  if (replacementPath) {
    res.setHeader('Link', `<${replacementPath}>; rel="successor-version"`);
    res.setHeader('Deprecation-Warning', `This endpoint is deprecated. Use ${replacementPath}`);
  }
}

module.exports = {
  ok,
  fail,
  setDeprecationHeaders,
};
