var _ = require("lodash-node");
var moment = require('moment');

var amountMeta = function(tot) {
  var meta = []

  meta.push("AMOUNTSIGN"+(tot<0?"NEGATIVE":"POSITIVE"))

  if ( Math.abs(tot) < 10 ) meta.push("AMOUNTMETALTTEN")
  else if ( Math.abs(tot) < 20 ) meta.push("AMOUNTMETA_LTTWENTY")
  else if ( Math.abs(tot) < 30 ) meta.push("AMOUNTMETA_LTTHIRTY")
  else if ( Math.abs(tot) < 50 ) meta.push("AMOUNTMETA_LTFIFTY")
  else if ( Math.abs(tot) < 100 ) meta.push("AMOUNTMETA_LTHUNDRED")
  else if ( Math.abs(tot) < 500 ) meta.push("AMOUNTMETA_LTFIVEHUNDRED")
  else if ( Math.abs(tot) < 1000 ) meta.push("AMOUNTMETA_LTTHOUSAND")

  else meta.push("AMOUNTMETALARGE")
  var totstr = ""+Math.abs(tot);
  meta.push("TOTAL_"+totstr)
  //meta.push(["TOTAL",totstr.replace(/\./,"X").replace(/,/,"C")].join(""));
  return meta
}


var Xact = function(data, acct) {

  function convertAmount(pamt) {
    var amt = parseFloat(pamt.amount[0].quantity[0])
    var sym = (pamt.amount[0].commodity ? pamt.amount[0].commodity.symbol : '$')
    return { cmdty: sym, val: -amt }
  }

  if ( data == undefined ) return;

  // read from ledger xml output
  if ( data && data.date && data.payee && data.postings ) { // looks like ledger
    _.merge( this, data )
    var ps = []

    this.date = moment(data.date[0])
    this.payee = this.payee[0]

    // get splits
    var tot = 0;
    _.each(this.postings[0].posting, function( p ) {
      var a = p.account[0];
      p.account = { ref: a['$'].ref, name: a.name[0] };

      
      // only record nonzero splits
      var pamt = p['post-amount'][0]
      var amt = convertAmount(pamt)
      delete p['post-amount']
      delete p.total
      p.amt = amt;
      if ( amt.val != 0 ) {
        ps.push(p)
        tot += amt.val
      }
    });
    ps.push( { account: { name: acct },
               amt: { cmdty: '$' , val: -tot } })
    this.postings = ps;

    // get metadata
    var metadata = {}
    if ( this.metadata ) {
      _.each(data.metadata[0].value, function (v) {
        var k = v['$'].key.trim();
        if ( v.string ) {
          metadata[k] = v.string.join("\n").trim();
        }
      });
    }
    this.metadata = metadata
  } else if ( data && data.DTPOSTED && data.NAME && data.FITID ) {
    
    this.date = dp2date(data.DTPOSTED)
    this.payee = data.NAME
    this.memo = data.MEMO
    this.metadata = { fitid: data.FITID }
    
    // dummy transaction
    var ps = []
    ps.push( { account: 0,
               amt: { cmdty: '$', val: parseFloat(data.TRNAMT) } })

    ps.push( { account: {name: acct},
               amt: { cmdty: '$', val: -parseFloat(data.TRNAMT) } })

    this.postings = ps;
    
  } else {
    throw new Error("Unable to parse XACT data")
  }
  //console.log(JSON.stringify(this,null,'  '))

  this.amount = function() { return this.postings.slice(-1).pop().amt.val }
  this.acct   = function() { 
    var pp = this.postings.slice(-1).pop();
    if ( !pp.account ) return "UNKNOWN:"+JSON.stringify(pp)
    else return pp.account.name
  }
  this.bkey = function () { 
    return [this.date.format("YYYY"), this.acct()].join(":") }
  this.tkey = function () {
    var adds = []
    var tot = this.postings.slice(-1).pop().amt.val
    adds.push( amountMeta(-tot) )
    var tkey = _.flatten([this.payee,adds]).join(" ")
    return tkey;
  }
  this.total = function() {
    return this.postings.slice(-1).pop().amt.val
  }
  this.fitid = function() {
    return (this.metadata.fitid?this.metadata.fitid:this.metadata.FITID)
  }
    
}

function dp2date(dtposted) {
  return moment(dtposted.replace(/^(\d\d\d\d)(\d\d)(\d\d).*$/,"$2/$3/$1"))
}



function stripXact( xact ) {
  var xact_stripped = _.merge(new Xact(),xact)

  // now standardize
  var tot = xact_stripped.total()
  _.each(xact_stripped.postings,function(p) {
    p.amt.val = p.amt.val/tot;
  });
  
  // remove items we don't want to capture
  _.each(['payee','date','fitid','metadata','$'], function(k) { delete xact_stripped[k] });
  return xact_stripped
}



exports.amountMeta = amountMeta;
exports.Xact = Xact;
exports.dp2date = dp2date;
exports.stripXact = stripXact;
