import { verifyRequester } from "../../_lib/supabaseAdmin.js";
import { getFreshAccess } from "../../_lib/connectors.js";

function validName(value){return /^[A-Za-z0-9_.-]{1,100}$/.test(String(value||""))&&value!=="."&&value!=="..";}
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store, private");
  if(req.method!=="GET")return res.status(405).json({error:"method_not_allowed"});
  const {userId,email}=await verifyRequester(req);if(!userId||!email)return res.status(401).json({error:"authentication_required"});
  const owner=String(req.query?.owner||""),repo=String(req.query?.repo||""),path=String(req.query?.path||"").slice(0,500);
  if(!validName(owner)||!validName(repo)||path.split("/").some((p)=>p===".."))return res.status(400).json({error:"invalid_repository_path"});
  try{
    const connection=await getFreshAccess(userId,"github");if(!connection)return res.status(404).json({error:"not_connected"});
    const ref=String(req.query?.ref||"").slice(0,100);
    const url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`+(ref?`?ref=${encodeURIComponent(ref)}`:"");
    const response=await fetch(url,{headers:{Authorization:`Bearer ${connection.accessToken}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(response.status===404?404:502).json({error:"github_tree_failed",message:"That repository path could not be read."});
    const entries=(Array.isArray(data)?data:[data]).slice(0,100).map((item)=>({name:item.name,path:item.path,type:item.type,size:item.size||0,sha:item.sha,downloadUrl:item.download_url||null,htmlUrl:item.html_url||null}));
    return res.status(200).json({entries});
  }catch(error){return res.status(503).json({error:"connector_unavailable",message:error.message});}
}
