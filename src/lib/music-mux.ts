import { BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output } from 'mediabunny'

// 把音乐的主音轨混进 MP4 成片：视频流逐包原样拷贝（不重编码），丢弃成片原有的所有音轨，换成音乐文件的主音轨。
// 音乐是预先做好的 AAC（m4a），时长应等于成片；时间戳不早于视频时长的音频包丢掉，保证音频不超出画面。
// 没有视频轨或音乐里没有音轨时抛错，由调用方决定怎么降级。
export async function muxMusic(video: Uint8Array, music: Uint8Array): Promise<Uint8Array> {
  const videoInput = new Input({ source: new BufferSource(video), formats: [MP4] })
  const musicInput = new Input({ source: new BufferSource(music), formats: [MP4] })
  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack()
    if (!videoTrack) throw new Error('music-mux: video has no video track')
    const audioTrack = await musicInput.getPrimaryAudioTrack()
    if (!audioTrack) throw new Error('music-mux: music file has no audio track')

    const duration = await videoTrack.computeDuration()
    const target = new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const videoSource = new EncodedVideoPacketSource(videoTrack.codec!)
    const audioSource = new EncodedAudioPacketSource(audioTrack.codec!)
    output.addVideoTrack(videoSource, { rotation: videoTrack.rotation })
    output.addAudioTrack(audioSource)
    await output.start()

    // 第一包带 decoderConfig，之后的包沿用
    const videoConfig = await videoTrack.getDecoderConfig()
    let first = true
    for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
      await videoSource.add(packet, first ? { decoderConfig: videoConfig! } : undefined)
      first = false
    }
    const audioConfig = await audioTrack.getDecoderConfig()
    first = true
    for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
      if (packet.timestamp >= duration) break
      await audioSource.add(packet, first ? { decoderConfig: audioConfig! } : undefined)
      first = false
    }
    await output.finalize()
    return new Uint8Array(target.buffer!)
  } finally {
    videoInput.dispose()
    musicInput.dispose()
  }
}
