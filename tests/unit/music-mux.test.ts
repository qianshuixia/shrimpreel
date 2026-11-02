import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, Mp4OutputFormat, Output } from 'mediabunny'
import { muxMusic } from '#/lib/music-mux'

const video = new Uint8Array(readFileSync('tests/fixtures/video-6s.mp4'))
const music = new Uint8Array(readFileSync('tests/fixtures/music-6s.m4a'))

const open = (bytes: Uint8Array) => new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })

async function packets(input: Input, kind: 'video' | 'audio') {
  const track = kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack()
  const list: { data: Uint8Array; timestamp: number }[] = []
  for await (const p of new EncodedPacketSink(track!).packets()) list.push({ data: p.data, timestamp: p.timestamp })
  return list
}

describe('muxMusic', () => {
  it('视频包原样拷贝；音轨换成音乐文件的（原片的音轨被丢掉），且不超过视频时长', async () => {
    const out = open(await muxMusic(video, music))
    expect(await out.getVideoTracks()).toHaveLength(1)
    const audioTracks = await out.getAudioTracks()
    expect(audioTracks).toHaveLength(1)
    expect(audioTracks[0]!.codec).toBe('aac')

    const srcVideo = await packets(open(video), 'video')
    const outVideo = await packets(out, 'video')
    expect(outVideo).toHaveLength(srcVideo.length)
    outVideo.forEach((p, i) => expect(Buffer.compare(p.data, srcVideo[i]!.data), `video packet ${i}`).toBe(0))

    const outAudio = await packets(out, 'audio')
    const musicAudio = await packets(open(music), 'audio')
    const originalAudio = await packets(open(video), 'audio')
    expect(Buffer.compare(outAudio[0]!.data, musicAudio[0]!.data)).toBe(0)
    expect(Buffer.compare(outAudio[0]!.data, originalAudio[0]!.data)).not.toBe(0)

    const videoDuration = await (await open(video).getPrimaryVideoTrack())!.computeDuration()
    expect(outAudio.at(-1)!.timestamp).toBeLessThan(videoDuration)
  })

  it('音乐文件没有音轨时抛错；视频文件没有视频轨（传入音乐文件）时抛错', async () => {
    // 只含视频轨的 MP4：把原片的视频包原样写进去
    const track = (await open(video).getPrimaryVideoTrack())!
    const target = new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat(), target })
    const source = new EncodedVideoPacketSource(track.codec!)
    output.addVideoTrack(source)
    await output.start()
    const config = await track.getDecoderConfig()
    let first = true
    for await (const p of new EncodedPacketSink(track).packets()) {
      await source.add(p, first ? { decoderConfig: config! } : undefined)
      first = false
    }
    await output.finalize()
    await expect(muxMusic(video, new Uint8Array(target.buffer!))).rejects.toThrow(/no audio track/)
    await expect(muxMusic(music, music)).rejects.toThrow(/no video track/)
  })
})
