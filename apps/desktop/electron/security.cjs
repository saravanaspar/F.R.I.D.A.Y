const { pathToFileURL } = require("node:url");

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AUTH_PAYLOAD_PREFIX = "friday-client-auth-v1:";

function validatedDeviceId(value) {
  if (typeof value !== "string" || !DEVICE_ID.test(value)) throw new Error("device id is invalid");
  return value;
}

function validatedDeviceName(value) {
  if (typeof value !== "string") throw new Error("device name is invalid");
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("device name is invalid");
  return normalized;
}

function validatedSigningPayload(value) {
  if (typeof value !== "string" || value.length > 256_000 || !value.startsWith(AUTH_PAYLOAD_PREFIX) || /\u0000/u.test(value)) {
    throw new Error("device signing payload is invalid");
  }
  return value;
}

function credentialFileName(deviceId) {
  return `credential-${encodeURIComponent(`device:${validatedDeviceId(deviceId)}`)}`;
}

function rendererUrl(indexPath) {
  return pathToFileURL(indexPath).toString();
}

function isTrustedRendererUrl(url, indexPath) {
  return typeof url === "string" && url === rendererUrl(indexPath);
}

module.exports = Object.freeze({ credentialFileName, rendererUrl, isTrustedRendererUrl, validatedDeviceId, validatedDeviceName, validatedSigningPayload });
