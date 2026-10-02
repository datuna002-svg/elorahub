import { verifyRequester } from "../../_lib/supabaseAdmin.js";
import { getFreshAccess } from "../../_lib/connectors.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if(req.method!=="GET")return res.status(405).json({error:"method_not_allowed"});
  const {userId,email}=await verifyRequester(req);
  if(!userId||!email)return res.status(401).json({error:"authentication_required"});
  try{
    const connection=await getFreshAccess(userId,"github"); if(!connection)return res.status(404).json({error:"not_connected"});
    const response=await fetch("https://api.github.com/installation/repositories?per_page=100",{headers:{Authorization:`Bearer ${connection.accessToken}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(502).json({error:"github_list_failed",message:"GitHub could not list this app installation's repositories."});
    const query=String(req.query?.q||"").trim().toLowerCase().slice(0,120);
    const repositories=(data.repositories||[]).filter((r)=>!query||`${r.full_name} ${r.description||""}`.toLowerCase().includes(query)).slice(0,40).map((r)=>({id:r.id,fullName:r.full_name,owner:r.owner?.login,name:r.name,description:r.description||"",private:!!r.private,defaultBranch:r.default_branch,url:r.html_url,permissions:r.permissions||{}}));
    return res.status(200).json({repositories});
  }catch(error){return res.status(503).json({error:"connector_unavailable",message:error.message});}
}
