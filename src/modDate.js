module.exports = (wpDate, imtDate) => {
  // uses valid imt_date, otherwise uses wordpress date
  let date = 0
  if (imtDate !== undefined && imtDate.length > 0) {
    // imt_date format is 20180302
    date = new Date(
      imtDate.substring(0, 4),
      imtDate.substring(4, 6),
      imtDate.substring(6, 8)
    ).getTime()
  } else date = new Date(wpDate).getTime()
  return date
}
