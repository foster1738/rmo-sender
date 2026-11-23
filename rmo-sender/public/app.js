let token = localStorage.getItem("rmo_token");
const $ = id => document.getElementById(id);
async function api(path, options={}) {
  const r = await fetch("/api"+path, { ...options, headers: { "Content-Type":"application/json", ...(token?{Authorization:"Bearer "+token}:{}), ...(options.headers||{}) } });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
function showApp() { $("auth").hidden=true; $("app").hidden=false; $("userLabel").textContent="Workspace"; refreshAll(); }
async function signIn(mode) {
  try {
    const d=await api("/auth/"+mode,{method:"POST",body:JSON.stringify({email:$("email").value,password:$("password").value})});
    token=d.token; localStorage.setItem("rmo_token",token); $("authMsg").textContent="Signed in."; showApp();
  } catch(e){$("authMsg").textContent=e.message;}
}
$("login").onclick=()=>signIn("login"); $("register").onclick=()=>signIn("register");
$("logout").onclick=()=>{localStorage.removeItem("rmo_token");token=null;location.reload();};
async function refreshAll(){
  try{
    const [campaigns,accounts,contacts]=await Promise.all([api("/campaigns"),api("/accounts"),api("/contacts")]);
    $("campaignCount").textContent=campaigns.length;$("contactCount").textContent=contacts.length;$("accountCount").textContent=accounts.length;
    $("sentCount").textContent=campaigns.reduce((n,c)=>n+c.sent,0);
    $("account").innerHTML=accounts.map(a=>`<option value="${a.id}">${escapeText(a.email)} · ${escapeText(a.displayName)}</option>`).join("")||'<option value="">Connect an account first</option>';
    $("accountList").innerHTML=accounts.map(a=>`<div class="listitem"><b>${escapeText(a.displayName)}</b><br>${escapeText(a.email)} · ${escapeText(a.status)}</div>`).join("")||"No accounts connected.";
    $("history").innerHTML=campaigns.map(c=>`<tr><td>${escapeText(c.name)}</td><td>${escapeText(c.subject)}</td><td>${escapeText(c.status)}</td><td>${c.total}</td><td>${c.sent}</td><td>${c.failed}</td><td><button class="secondary" data-duplicate="${c.id}">Duplicate</button> <button data-send="${c.id}">Queue</button></td></tr>`).join("")||'<tr><td colspan="7">No campaigns yet.</td></tr>';
    document.querySelectorAll("[data-send]").forEach(b=>b.onclick=async()=>{if(!confirm("Queue this campaign to eligible opted-in contacts?"))return;try{const x=await api(`/campaigns/${b.dataset.send}/send`,{method:"POST",body:"{}"});alert(`${x.queued} messages queued.`);refreshAll()}catch(e){alert(e.message)}});
    document.querySelectorAll("[data-duplicate]").forEach(b=>b.onclick=async()=>{try{await api(`/campaigns/${b.dataset.duplicate}/duplicate`,{method:"POST",body:"{}"});refreshAll();}catch(e){alert(e.message)}});
  }catch(e){if(e.message==="Sign in required"){ $("auth").hidden=false;$("app").hidden=true;}else console.error(e);}
}
$("connectGoogle").onclick=async()=>{try{const x=await api("/connect/google");location.href=x.url;}catch(e){alert(e.message)}};
$("saveCampaign").onclick=async()=>{try{const c=await api("/campaigns",{method:"POST",body:JSON.stringify({name:$("cname").value,subject:$("subject").value,html:$("html").value,accountId:$("account").value})});$("campaignMsg").textContent="Campaign saved. It will not send until you explicitly queue it.";refreshAll();}catch(e){$("campaignMsg").textContent=e.message}};
$("scan").onclick=()=>{const matches=[...new Set([...$("html").value.matchAll(/{{\\s*([\\w]+)\\s*}}/g)].map(m=>m[1]))];$("campaignMsg").textContent=matches.length?"Detected placeholders: "+matches.join(", "):"No {{placeholder}} fields found.";};
$("askAI").onclick=async()=>{ $("aiResult").textContent="Thinking…";try{const x=await api("/ai/assist",{method:"POST",body:JSON.stringify({task:$("aiTask").value,prompt:$("aiPrompt").value,html:$("html").value})});$("aiResult").textContent=x.result;}catch(e){$("aiResult").textContent=e.message}};
$("importContacts").onclick=async()=>{try{const contacts=JSON.parse($("contactsJson").value);const x=await api("/contacts/import",{method:"POST",body:JSON.stringify({contacts})});$("contactMsg").textContent=`Imported ${x.imported} contacts.`;refreshAll()}catch(e){$("contactMsg").textContent=e.message}};
$("refresh").onclick=refreshAll;
function escapeText(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
if(token) showApp();