module.exports = (txt, links) => {
  // finds markdown shortlinks in content, appends full link to end of string
  /*
    links for the entire article are grouped together in the original markdown
    but we are dealing with single section of the article
    this finds the link references in this section and retrieves associated links
    */
  /*
*/
  const refReg = /\[\d{1,3}\]/g // match 1 or 2 length ref links
  let refLinks = txt.match(refReg)
  if (refLinks !== null) {
    txt += `\n`
    refLinks.forEach(refLink => {
      const ref = refLink.replace('[', '').replace(']', '')
      if (links[ref] === undefined) {
        throw new Error(`couldn't find ${ref} in ${Object.keys(links)}`)
      }
      const link = links[ref].href
      txt += `\n${refLink}: ${link}`
    })
  }
  return txt
}
