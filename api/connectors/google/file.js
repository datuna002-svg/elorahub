import { verifyRequester } from "../../_lib/supabaseAdmin.js";
import { getFreshAccess } from "../../_lib/connectors.js";

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "application/xml"]);
async function readLimited(response, maxBytes) {
  if (!response.ok) return null;
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const parts=[]; let total=0;
  while(true){
    const {done,value}=await reader.read(); if(done)break;
    total+=value.byteLength; if(total>maxBytes){await reader.cancel();throw new Error("This file is too large to use in chat (limit 150 KB)." );}
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts).toString("utf8");
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  const { userId, email } = await verifyRequester(req);
  if (!userId || !email) return res.status(401).json({ error: "authentication_required" });
  const fileId=String(req.query?.id||"");
  if(!/^[a-zA-Z0-9_-]{5,180}$/.test(fileId))return res.status(400).json({error:"invalid_file_id"});
  try{
    const connection=await getFreshAccess(userId,"google"); if(!connection)return res.status(404).json({error:"not_connected"});
    const auth={Authorization:`Bearer ${connection.accessToken}`};
    const metaResponse=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,size`,{headers:auth});
    const meta=await metaResponse.json().catch(()=>({}));
    if(!metaResponse.ok)return res.status(metaResponse.status===404?404:502).json({error:"drive_file_unavailable",message:"That file is not available to the connected Google account."});
    let url, outputType;
    if(meta.mimeType==="application/vnd.google-apps.document"){url=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`;outputType="text/plain";}
    else if(meta.mimeType==="application/vnd.google-apps.spreadsheet"){url=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fcsv`;outputType="text/csv";}
    else if(TEXT_TYPES.has(meta.mimeType)){url=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;outputType=meta.mimeType;}
    else return res.status(415).json({error:"unsupported_file_type",message:"This connector can read Google Docs, Sheets, and text files. Other file types are not extracted."});
    const contentResponse=await fetch(url,{headers:auth});
    if(!contentResponse.ok)return res.status(502).json({error:"drive_export_failed"});
    const content=await readLimited(contentResponse,150000);
    return res.status(200).json({id:meta.id,title:meta.name,mimeType:outputType,webViewLink:meta.webViewLink||null,content:String(content||"").slice(0,150000)});
  }catch(error){return res.status(502).json({error:"drive_file_read_failed",message:error.message||"Could not read this file."});}
}
