const fetch = require('isomorphic-unfetch')
const getRedirect = require('./getRedirect')

module.exports = async (id, imt_author, wp) => {
  // takes a wordpress id and imt_author, determines best value of authors array
  let authors = ['IMT member']
  let found = false

  // handle imt_author
  if (imt_author !== undefined && imt_author.length > 0) {
    // imt_author exists
    if (Array.isArray(imt_author)) {
      // is a populated array
      authors = imt_author
      found = true
    }
    if (typeof imt_author === 'string') {
      // is a string longer than 0
      authors = [imt_author]
      found = true
    }
  }

  if (!found) {
    // no imt_author, attempt to retrieve sa author
    const redirectDetails = await getRedirect({ new: id })
    const oldAuthor = redirectDetails.author

    if (oldAuthor !== undefined && oldAuthor.length > 0) {
      // oldAuthor is from old SA site
      authors = [oldAuthor]

      // detect multiple authors
      if (oldAuthor.includes(' & ')) authors = oldAuthor.split(' & ')
      if (oldAuthor.includes(' and ')) authors = oldAuthor.split(' and ')
    }
  }
  return authors
}
