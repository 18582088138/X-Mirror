export const VideoContentMode={fit:'fit'};
export const RealtimeModel={x2_1:'x2_1'};
export const RealtimeConnectionState={generating:'generating'};
export const XmaxEnvironment={china:'china',global:'global'};
export const defaultCameraVideoFormat=()=>({width:240,height:360,fps:15});
export class RealtimeConfiguration{constructor(value){Object.assign(this,value)}}
export class RealtimeContext{constructor(value){Object.assign(this,value)}}
export class XmaxConfiguration{constructor(value){Object.assign(this,value)}}
export class XmaxRealtimeVideoView{
 constructor(){this.element=document.createElement('div');this.videoElement=document.createElement('video');this.videoElement.autoplay=true;this.videoElement.muted=true;this.videoElement.playsInline=true;this.videoElement.style='width:100%;height:100%;object-fit:contain';this.element.append(this.videoElement)}
 attach(el){el.append(this.element)}
 set track(track){this.videoElement.srcObject=track?new MediaStream([track]):null;if(track)this.videoElement.play().catch(()=>{})}
}
export class XmaxClient{
 createStorageService(){return{uploadImage:async()=>({url:'https://example.test/reference.jpg'})}}
 createRealtimeManager(){return new Manager()}
}
class Manager{
 tracks=[];timers=[];
 setStateListener(listener){this.listener=listener}
 setDownlinkVideoStatisticsListener(listener){listener?.({width:240,height:360,decodedFrameRate:15})}
 setRemoteMediaTracksListener(listener){this.remoteListener=listener}
 makeStream(){const canvas=document.createElement('canvas');canvas.width=240;canvas.height=360;canvas.style='position:fixed;width:1px;height:1px;opacity:.01';document.body.append(canvas);const ctx=canvas.getContext('2d');let i=0;const draw=()=>{ctx.fillStyle=`hsl(${i++%360},25%,65%)`;ctx.fillRect(0,0,240,360);ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('TEST OUTPUT',25,180)};draw();this.timers.push(setInterval(draw,60));const track=canvas.captureStream(15).getVideoTracks()[0];this.tracks.push(track);return{videoTrack:track}}
 async createLocalImageStream({file}){globalThis.mockInputType='image';if(!(file instanceof File))throw new Error('input must be a File');return this.makeStream()}
 async createLocalVideoStream({file}){globalThis.mockInputType='video';if(!(file instanceof File))throw new Error('input must be a File');return this.makeStream()}
 async startGeneration({context,faceRestoration}){globalThis.mockPrompt=context.prompt;globalThis.mockFaceRestoration=faceRestoration;const stream=this.makeStream();this.remoteListener({videoTrack:stream.videoTrack});this.timers.push(setTimeout(()=>this.listener({connectionState:'generating'}),300));return stream}
 async close(){this.timers.forEach(t=>{clearInterval(t);clearTimeout(t)});this.tracks.forEach(t=>t.stop())}
}
