import { type Helpers, YTNodes } from 'youtubei.js';
import { describe, expect, it } from 'vitest';
import { videoIdOf } from '../src/youtube/YouTubeService.js';

/** Builds a parsed node of the given type without going through YouTube's raw JSON */
function node<T extends { type: string; prototype: object }>(
  cls: T,
  fields: Record<string, unknown>,
): Helpers.YTNode {
  return Object.assign(Object.create(cls.prototype) as Helpers.YTNode, {
    type: cls.type,
    ...fields,
  });
}

describe('videoIdOf', () => {
  it('reads classic video renderers', () => {
    expect(videoIdOf(node(YTNodes.Video, { video_id: 'vid1' }))).toBe('vid1');
    expect(videoIdOf(node(YTNodes.PlaylistVideo, { id: 'vid2' }))).toBe('vid2');
  });

  it('reads video lockup view models', () => {
    expect(videoIdOf(node(YTNodes.LockupView, { content_type: 'VIDEO', content_id: 'vid3' }))).toBe(
      'vid3',
    );
  });

  it('skips lockups that are not videos or have no ID', () => {
    expect(
      videoIdOf(node(YTNodes.LockupView, { content_type: 'PLAYLIST', content_id: 'PL1' })),
    ).toBeNull();
    expect(videoIdOf(node(YTNodes.LockupView, { content_type: 'VIDEO' }))).toBeNull();
  });

  it('skips other nodes', () => {
    expect(videoIdOf(node(YTNodes.Channel, { id: 'UC1' }))).toBeNull();
  });
});
