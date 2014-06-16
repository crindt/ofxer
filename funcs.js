var _ = require("lodash-node");
var moment = require('moment');
var async = require('async')
var classifier = require('classifier');
var Levenshtein = require('levenshtein')

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
    if ( this.note ) 
      this.note = this.note.join("").replace(/^.*:\s/)  // remove metadata from note

    // get splits
    var tot = 0;
    _.each(this.postings[0].posting, function( p ) {
      var a = p.account[0];
      p.account = { ref: a['$'].ref, name: a.name[0] };

      
      // only record nonzero splits
      var pamt = p['post-amount'][0]
      var amt = convertAmount(pamt)
      if ( p.note ) p.note = p.note.join("").replace(/^.*:\s/) // remove metdata from note

      var pp = {}
      if ( p.metadata ) {
        _.each(p.metadata, function(m) {
          _.each(m.value, function (mv) {
            var k = mv['$'].key
            var v = mv.string ? mv.string : mv.value
            pp[k] = v;
          });
        });
      }
      p.metadata = pp
      delete p['post-amount']
      delete p.total
      p.amt = amt;
      if ( amt.val != 0 ) {
        ps.push(p)
        tot += amt.val
      }
    });
    ps.push( { account: { name: acct },
               amt: { cmdty: '$' , val: -tot },
               metadata: {} })
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
    if ( data.CHECKNUM ) this.num = parseInt(data.CHECKNUM)
    this.metadata = {}
    
    // dummy transaction
    var ps = []
    ps.push( { account: 0,
               amt: { cmdty: '$', val: parseFloat(data.TRNAMT) }, 
               metadata: {} })

    ps.push( { account: {name: acct},
               amt: { cmdty: '$', val: -parseFloat(data.TRNAMT) }, 
               metadata: { fitid: data.FITID } } )

    this.postings = ps;
    
  } else {
    throw new Error("Unable to parse XACT data")
  }
  //console.log(JSON.stringify(this,null,'  '))

  this.amount = function() { return parseFloat(this.postings.slice(-1).pop().amt.val) }
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
  this.targetpost = function() { return this.postings.slice(-1).pop() }
  this.total = function() {
    return this.targetpost().amt.val
  }
  this.fitid = function() {
    var md = this.targetpost().metadata
    return (md && md.fitid?md.fitid:null)
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
    _.each(['fitid','metadata','$'], function(k) { delete p[k] });
  });
  
  // remove items we don't want to capture
  _.each(['payee','date','fitid','metadata','$'], function(k) { delete xact_stripped[k] });
  return xact_stripped
}


var classifiers = {}

function getClassifier(key,xact) {
  if ( !key ) throw new Error("MUST SPECIFY KEY!")
  var ybkey = [key,xact.bkey()].join(":")
  if ( !classifiers[ybkey] ) {
    classifiers[ybkey] = new classifier.Bayesian({
      backend: {
        type: 'Redis',
        options: {
          hostname: 'localhost',   // default
          port: 6379,              // default
          name: ybkey // namespace for persisting
        },
        thresholds: {
          "Expenses:Groceries:Food": 1,
          "Expenses:Groceries:Alcohol": 3
        }
      }
    });
  }
  return classifiers[ybkey]
}

function doTrain(key,xact,cb) {

  if ( !key ) throw new Error("MUST SPECIFY KEY!")

  // train for post year and following two years
  var pyear = moment(xact.date).year()
  var years = [pyear,pyear+1,pyear+2];

  async.each(years,function(y, cb2) {
    var ybkey = [key,y,xact.acct()].join(":")
    if ( !classifiers[ybkey] ) {
      classifiers[ybkey] = new classifier.Bayesian({
        backend: {
          type: 'Redis',
          options: {
            hostname: 'localhost',   // default
            port: 6379,              // default
            name: ybkey // namespace for persisting
          },
          thresholds: {
            "Expenses:Groceries:Food": 1,
            "Expenses:Groceries:Alcohol": 3
          }
        }
      });
    }

    var xact_stripped = stripXact( xact );
    var val = JSON.stringify( xact_stripped )

    classifiers[ybkey].train(xact.tkey(),
                            val, function() {
                              console.log("trained for ["+ybkey+"] '"+xact.tkey()+"' ->"+val);
                              cb2()
                            })
  }, function(err) {
    cb(err)
  })
}

// scored difference between transactions
function exDist(a, b) {
  // payee similarity, scaled by first payee length
  var ld = new Levenshtein(a.payee.toUpperCase(),b.payee.toUpperCase()).distance/a.payee.length
  // absolute pct distance (as a decimal) of the two amounts
  var ad = Math.abs(b.amount() - a.amount())/Math.abs(a.amount())
  return ld + ad
}

exports.amountMeta = amountMeta;
exports.Xact = Xact;
exports.dp2date = dp2date;
exports.stripXact = stripXact;
exports.doTrain = doTrain;
exports.getClassifier = getClassifier;
exports.exDist = exDist;
