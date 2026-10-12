const form=document.querySelector("#login-form"),message=document.querySelector("#login-message"),submit=document.querySelector("#submit-login"),password=document.querySelector("#password"),username=document.querySelector("#username"),toggle=document.querySelector("#toggle-password");
document.querySelector("#site-host").textContent=location.host;
function notice(text,error=false){message.textContent=text;message.classList.toggle("error",error);message.hidden=!text;}
const reason=new URLSearchParams(location.search).get("reason");
if(reason==="expired")notice("登录已过期，请重新登录后继续。");
if(reason==="logout")notice("已退出登录。");
toggle.onclick=()=>{const visible=password.type==="password";password.type=visible?"text":"password";toggle.textContent=visible?"隐藏":"显示";toggle.setAttribute("aria-label",visible?"隐藏密码":"显示密码");toggle.setAttribute("aria-pressed",String(visible));};
form.onsubmit=async event=>{
  event.preventDefault();if(submit.disabled)return;
  submit.disabled=true;submit.firstElementChild.textContent="正在登录…";notice("");username.removeAttribute("aria-invalid");password.removeAttribute("aria-invalid");
  try{
    const response=await fetch("/auth/admin/login",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify({username:username.value.trim(),password:password.value})});
    const result=await response.json();
    if(!response.ok){
      if(result.error?.code==="invalid_credentials"){username.setAttribute("aria-invalid","true");password.setAttribute("aria-invalid","true");password.focus();}
      throw new Error(result.error?.message||"登录暂时不可用，请稍后重试。");
    }
    password.value="";location.replace("/");
  }catch(error){notice(error instanceof TypeError?"无法连接管理服务，请稍后重试。":error.message,true);submit.disabled=false;submit.firstElementChild.textContent="登录控制台";}
};
