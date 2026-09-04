"use client";

import {
  backendApi,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "./backend-api";

function base64urlToBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function bufferToBase64url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCreationOptions(
  options: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64urlToBuffer(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    })),
  };
}

function decodeRequestOptions(
  options: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    })),
  };
}

function encodeCredential(credential: PublicKeyCredential) {
  const response = credential.response;

  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject:
        response instanceof AuthenticatorAttestationResponse
          ? bufferToBase64url(response.attestationObject)
          : undefined,
      authenticatorData:
        response instanceof AuthenticatorAssertionResponse
          ? bufferToBase64url(response.authenticatorData)
          : undefined,
      signature:
        response instanceof AuthenticatorAssertionResponse
          ? bufferToBase64url(response.signature)
          : undefined,
      userHandle:
        response instanceof AuthenticatorAssertionResponse && response.userHandle
          ? bufferToBase64url(response.userHandle)
          : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function ensurePasskeySupport() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Passkeys require a secure supported browser.");
  }
}

export async function registerPasskey(
  ownerAddress: string,
  deviceName: string,
  signMessage: (message: string) => Promise<string>,
) {
  ensurePasskeySupport();

  const challenge = await backendApi.auth.registerChallenge(ownerAddress);
  const signature = await signMessage(challenge.message);
  const serverOptions = await backendApi.auth.startRegister(
    ownerAddress,
    challenge.challengeId,
    signature,
  );

  const credential = await navigator.credentials.create({
    publicKey: decodeCreationOptions(serverOptions),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey registration was cancelled.");
  }

  const result = await backendApi.auth.finishRegister(
    ownerAddress,
    encodeCredential(credential),
    deviceName,
  );

  return result;
}

export async function authenticatePasskey(ownerAddress: string) {
  ensurePasskeySupport();

  const serverOptions = await backendApi.auth.startLogin(ownerAddress);
  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(serverOptions),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey authentication was cancelled.");
  }

  const result = await backendApi.auth.finishLogin(
    ownerAddress,
    encodeCredential(credential),
  );

  setSessionToken(result.token);
  return result;
}
