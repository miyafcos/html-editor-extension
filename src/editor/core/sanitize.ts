const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const TEMPLATE_RE = /<template\s+data-orig-script="1"([^>]*)>([\s\S]*?)<\/template\s*>/gi;

export function disarmScripts(bodyInner: string): string {
  return bodyInner.replace(SCRIPT_RE, (_m, attrs: string, content: string) =>
    `<template data-orig-script="1"${attrs}>${content}</template>`
  );
}

export function rearmScripts(bodyInner: string): string {
  return bodyInner.replace(TEMPLATE_RE, (_m, attrs: string, content: string) =>
    `<script${attrs}>${content}</script>`
  );
}
