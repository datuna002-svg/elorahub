import { verifyRequester } from "../../_lib/supabaseAdmin.js";
import { getFreshAccess } from "../../_lib/connectors.js";

function validName(value){return /^[A-Za-z0-9_.-]{1,100}$/.test(String(value||""))&&value!=="."&&value!=="..";}
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store, private");
  if(req.method!=="GET")return res.status(405).json({error:"method_not_allowed"});
  const {userId,email}=await verifyRequester(req);if(!userId||!email)return res.status(401).json({error:"authentication_required"});
  const owner=String(req.query?.owner||""),repo=String(req.query?.repo||""),path=String(req.query?.path||"").slice(0,500);
  if(!validName(owner)||!validName(repo)||!path||path.split("/").some((p)=>!p||p==="."||p===".."))return res.status(400).json({error:"invalid_file_path"});
  try{
    const connection=await getFreshAccess(userId,"github");if(!connection)return res.status(404).json({error:"not_connected"});
    const url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response=await fetch(url,{headers:{Authorization:`Bearer ${connection.accessToken}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(response.status===404?404:502).json({error:"github_file_failed",message:"GitHub could not read that file."});
    if(data.type!=="file"||Number(data.size||0)>150000||!data.content)return res.status(415).json({error:"unsupported_file",message:"Choose a text file under 150 KB."});
    const content=Buffer.from(String(data.content).replace(/\s/g,""),"base64").toString("utf8");
    if(content.includes("\u0000"))return res.status(415).json({error:"binary_file",message:"Binary files cannot be added to chat."});
    return res.status(200).json({title:`${owner}/${repo}/${path}`,path,content:content.slice(0,150000),htmlUrl:data.html_url||null});
  }catch(error){return res.status(503).json({error:"connector_unavailable",message:error.message});}
}
