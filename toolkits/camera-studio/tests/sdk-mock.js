export const XmaxEnvironment={china:'china',global:'global'};
export class XmaxConfiguration{constructor(value){Object.assign(this,value)}}
export class XmaxClient{
 createStorageService(){return{
  uploadVideo:async({data})=>{if(!(data instanceof File))throw new Error('video must be a File');return{url:'https://example.test/source.mp4'}},
  uploadImage:async()=>({url:'https://example.test/reference.jpg'})}}
}
