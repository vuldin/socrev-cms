const URL = require('url-parse')
const getRedirect = require('./getRedirect')

module.exports = async (oldLinks, wp) => {
  strLinks = oldLinks.split('\n')
  let modLinks = {}
  const mdLinkRe = /\[(\d{1,3})\]\:\ (.*)/
  strLinks.forEach((d, i) => {
    const match = d.match(mdLinkRe)
    modLinks[match[1]] = { href: match[2] }
  })
  // attempts to replace non-working links
  // replaces known bad links (i.e. to wp or old sa site)
  let linkObjs = {}
  await Promise.all(
    Object.entries(modLinks).map(async ([key, val]) => {
      if (val.href.length === 0) {
        // link is empty
        console.log('> empty link')
        console.log(val)
        val.href = '/'
      }
      const rUrlRe = /(^\/{1,2}[0-9a-zA-Z]*)\w+/ // detect relative url
      const rUrlMatch = val.href.match(rUrlRe)
      if (rUrlMatch === null) {
        // not a relative url
        const url = new URL(val.href)

        if (url.hostname.includes('socialistappeal.org')) {
          // socialistappeal links
          const idRe = /(\/[0-9])\w+/ // grab id from url path
          const idMatch = url.pathname.match(idRe)
          if (idMatch !== null) {
            const oldId = parseInt(idMatch[0].substring(1))
            const redirectFromSaId = await getRedirect({ old: oldId })
            const slugFromSaId =
              redirectFromSaId.slug !== undefined ? redirectFromSaId.slug : ''
            val.href = `/${slugFromSaId}`
            //console.log('> using wp p query slug')
            //console.log(val.href)
          } else {
            if (url.pathname === '/') val.href = '/'
            else {
              console.log(`> no id found in url ${url}`)
              val.href = '/404'
            }
          }
        }

        if (url.hostname.includes('wp.socialistrevolution.org')) {
          // wp-admin link in a post somehow
          if (url.pathname.includes('wp-admin')) {
            console.log('> wp-admin')
            val.href = '/404'
          } else {
            // wordpress p query links
            // check if url looks like https://wp.socialistrevolution.org/?p=4438
            // regex matches a 4 or 5 digit-long id on url.query
            let pUrlRe = /^(\?p=)([0-9]{4,5})$/
            const pUrlMatch = url.query.match(pUrlRe)
            if (pUrlMatch !== null) {
              const newId = parseInt(pUrlMatch[2])

              // retrieve slug from sr id
              // pull from wordpress (instead of redirects collection) since wordpress is source of truth
              let slugFromSrId = ''
              try {
                const postFromId = await wp.posts().id(newId)
                slugFromSrId = postFromId.id
              } catch (err) {
                console.log(`> id ${newId} not found in wordpress, using /404`)
                slugFromSrId = '404'
              }
              val.href = `/${slugFromSrId}`
            } else {
              // link doesn't contain an id, instead pathname may contain just a slug
              val.href = url.pathname
            }
          }
        }
      }
      linkObjs[key] = val
    })
  )
  return linkObjs

  /*
  // secondary pass through on remaining unknown links does three things:
  // - skips any links known to work (back to our site)
  // - tests if any other links are broken
  // - broken links are queried on archive.org

  const assumeWorkingLink = link => {
    // some sites return 400- or redirect-level HTTP errors to crawlers
    // this assumes some of those sites will be able to handle their link
    let result = false
    if (link.includes('www.npr.org')) result = true
    if (link.includes('www.theguardian.com')) result = true
    return result
  }

  let results = []
  await Promise.all(
    linkObjs.map(async d => {
      if (!d.known) {
        if (assumeWorkingLink(d.link)) {
          results.push({
            orig: d.link,
            works: true,
          })
        } else {
          // test link
          const response = await fetch(d.link, { method: 'HEAD' })
          //console.log(`${response.status}: ${d}`)
          // TODO issue get request on HTTP 405 'Method Not Allowed' error
          if (response.status >= 400) {
            // give an alternate link for the non-working link
            // give an image if we detect an image link, otherwise to the homepage
            let altUrl = '/'
            const imgRe = /(http)?s?:?(\/\/[^"']*\.(?:png|jpg|jpeg|gif|png|svg))/
            const match = d.link.match(imgRe)
            if (match !== null) altUrl = '/static/imt-wil-logo.jpg'
            results.push({
              orig: d.link,
              works: false,
              alt: altUrl,
            })
          } else {
            // url returned successfully
            results.push({
              orig: d.link,
              works: true,
            })
          }
        }
      } else {
        // url is one of the known working ones detected earlier
        results.push({
          orig: d.link,
          works: true,
        })
      }
    })
  )
  return results
  */
}
