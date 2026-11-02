// UTC month anniversaries; Jan 31 + one month ends on February's last day.
export function monthlyWindows(issuedAt) {
  const issue=new Date(issuedAt), start=Date.UTC(issue.getUTCFullYear(),issue.getUTCMonth(),issue.getUTCDate());
  return [1,2,3].map(months=>{
    const y=issue.getUTCFullYear(),m=issue.getUTCMonth()+months;
    const end=Date.UTC(y,m,Math.min(issue.getUTCDate(),new Date(Date.UTC(y,m+1,0)).getUTCDate()));
    return {months,days:(end-start)/86400000,startDate:new Date(start+86400000).toISOString().slice(0,10),endDate:new Date(end).toISOString().slice(0,10)};
  });
}
