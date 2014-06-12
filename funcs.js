var amountMeta = function(tot) {
  var meta = []
/*
  var meta.push("AMOUNTSIGN"+(tot<0?"NEGATIVE":"POSITIVE"))
*/
  if ( Math.abs(tot) < 10 ) meta.push("AMOUNTMETALTTEN")
/*
  if ( Math.abs(tot) < 20 ) meta.push("AMOUNTMETA_LTTWENTY")
  if ( Math.abs(tot) < 30 ) meta.push("AMOUNTMETA_LTTHIRTY")
  if ( Math.abs(tot) < 50 ) meta.push("AMOUNTMETA_LTFIFTY")
  else if ( Math.abs(tot) < 100 ) meta.push("AMOUNTMETA_LTHUNDRED")
  else if ( Math.abs(tot) < 500 ) meta.push("AMOUNTMETA_LTFIVEHUNDRED")
  else if ( Math.abs(tot) < 1000 ) meta.push("AMOUNTMETA_LTTHOUSAND")
*/
  else meta.push("AMOUNTMETALARGE")
  var totstr = ""+tot;
  meta.push("TOTAL_"+tot)
  //meta.push(["TOTAL",totstr.replace(/\./,"X").replace(/,/,"C")].join(""));
  return meta
}

exports.amountMeta = amountMeta;
