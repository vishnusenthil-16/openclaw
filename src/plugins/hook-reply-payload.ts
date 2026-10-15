import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  collectReplyMediaEntries,
  recordReplyPayloadMediaSelectionChange,
} from "../infra/outbound/reply-media-entries.js";
import type { PluginHookReplyPayload } from "./hook-types.js";

export const toPluginReplyPayload = (payload: ReplyPayload): PluginHookReplyPayload => {
  const { trustedLocalMedia: _trustedLocalMedia, ...visiblePayload } = payload;
  // Media comparisons must retain the host's references across plugin edits.
  return payload.mediaUrls
    ? { ...visiblePayload, mediaUrls: [...payload.mediaUrls] }
    : visiblePayload;
};
const areMediaUrlArraysEqual = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
};
const preservesTrustedMediaRefs = (
  previous: ReplyPayload,
  next: PluginHookReplyPayload,
): boolean => {
  return (
    previous.trustedLocalMedia === true &&
    previous.mediaUrl === next.mediaUrl &&
    areMediaUrlArraysEqual(previous.mediaUrls, next.mediaUrls)
  );
};
export const acceptPluginReplyPayload = (
  previous: ReplyPayload,
  next: PluginHookReplyPayload,
): ReplyPayload => {
  const visiblePayload = toPluginReplyPayload(next);
  const acceptedPayload = preservesTrustedMediaRefs(previous, visiblePayload)
    ? { ...visiblePayload, trustedLocalMedia: true }
    : visiblePayload;
  return recordReplyPayloadMediaSelectionChange(
    collectReplyMediaEntries(previous).map(({ url }) => url),
    copyReplyPayloadMetadata(previous, acceptedPayload),
  );
};
